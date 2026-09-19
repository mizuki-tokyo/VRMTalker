import * as THREE from "three";
import {
    VRMExpression,
    VRMExpressionMorphTargetBind,
    VRMExpressionPresetName,
    VRMUtils
} from "@pixiv/three-vrm";

import ActionManager from "./action-manager.js"
import VRMSmoothLookAt from './vrm-smooth-lookat.js';
import AudioPlayer from "./audio-player.js";

import registFaceExpression from "./vrm-expression-editor.js";

//const FADE_TIME = 0.2;
const FADE_TIME = 0.5;

// リップシンク: 推定した母音と VRM の口形状プリセットの対応
const LIP_SYNC_PRESETS = Object.freeze({
    a: VRMExpressionPresetName.Aa,
    i: VRMExpressionPresetName.Ih,
    u: VRMExpressionPresetName.Ou,
    e: VRMExpressionPresetName.Ee,
    o: VRMExpressionPresetName.Oh
});

const LIP_SYNC_GAIN = 10.0;           // RMS を口の開き具合 (0-1) に変換する係数
const LIP_SYNC_SMOOTHING = 0.5;       // 現在値から目標値への補間率
const LIP_SYNC_SILENCE_RMS = 0.01;    // これ未満は無音とみなして口を閉じる
const LIP_SYNC_MIN_CONFIDENCE = 0.25; // 5 母音が等距離だと 0.2。それより有意な場合のみ口形状を切り替える

class VrmHumanoid {
    _currentVrm = undefined;
    _actionManager = undefined;
    _activeAction = undefined;
    _defaultAction = undefined;
    _audioPlayer = undefined;

    // リップシンクの現在の重み。急に切り替わらないよう毎回目標値へ補間する
    _lipSyncWeights = {a: 0, i: 0, u: 0, e: 0, o: 0};
    _currentVowel = "a";

    // 再生中モーションの完了を待っている Promise の resolve
    _actionResolve = null;

    // 再生中の音声の完了を待っている Promise の resolve / reject
    _soundSettle = null;

    constructor(vrm) {
        this._currentVrm = vrm;
        this._actionManager = new ActionManager(vrm);

        this._audioPlayer = new AudioPlayer();
        this._audioPlayer.onPlayStart = this._onPlayStart.bind(this);
        this._audioPlayer.onAnalyzed = this._onAnalyzed.bind(this);
        this._audioPlayer.onPlayEnd = this._onPlayEnd.bind(this);
        this._audioPlayer.onPlayError = this._onPlayError.bind(this);
    }

    /** リップシンクの母音推定に使う参照フォルマント。"male"（低め） または "female"（高め） */
    set voiceType(type) {
        this._audioPlayer.voiceType = type;
    }

    get vrm() {
        return this._currentVrm;
    }

    get position() {
        return this._currentVrm.scene.position.clone();
    };

    // 値が 0 のときも設定する（`if (pos.x)` だと 0 が falsy で無視されてしまう）
    set position(pos) {
        if (pos.x !== undefined) { // right / left
            this._currentVrm.scene.position.x = pos.x;
        }
        if (pos.y !== undefined) { // up / down
            this._currentVrm.scene.position.y = pos.y;
        }
        if (pos.z !== undefined) { // front / back
            this._currentVrm.scene.position.z = pos.z;
        }
    };

    getMeta() {
        return this._currentVrm.meta;
    }

    /**
     * @param {string}  url
     * @param {boolean} [defaultAction] 既定（ループする待機）モーションにする
     * @param {string}  [name] 登録する名前。省略するとファイル名から作る
     */
    async loadAnimation(url, defaultAction=false, name="") {
        const action = await this._actionManager.loadAnimation(url, name);
        if (defaultAction === true) {
            this.setDefaultAction(action);
        }
    }

    /** 読み込み済みのモーション名。 */
    getActionNames() {
        return this._actionManager.getActionNames();
    }

    setDefaultAction(action) {
        this._defaultAction = action;
        this._defaultAction.setLoop(THREE.LoopRepeat);
        this._activeAction = action;
        action.play();
    }

    set lookAtTarget(camera) {
        // replace the lookAt to our extended one
        const vrm = this._currentVrm;
        const smoothLookAt = new VRMSmoothLookAt(vrm.humanoid, vrm.lookAt.applier);
        smoothLookAt.copy(vrm.lookAt);
        vrm.lookAt = smoothLookAt;
        vrm.lookAt.target = camera;
    }

    update(deltaTime, elapsedTime) {
        if (this._actionManager) {
            this._actionManager.update(deltaTime);
        }

        // update vrm
        if (this._currentVrm) {
            this._currentVrm.update(deltaTime);

            // auto blink
            this._currentVrm.expressionManager.setValue(VRMExpressionPresetName.Blink, this._blinkValue(elapsedTime));
        }
    }

    /** シーンから外す際に呼ぶ。GPU リソースを解放する。 */
    dispose() {
        // 待っている呼び出し元を残さない
        this._actionManager.onFinish = null;
        this._settleAction();
        this._settleSound();

        if (this._currentVrm) {
            VRMUtils.deepDispose(this._currentVrm.scene);
            this._currentVrm = undefined;
        }
    }

    /**
     * モーションを再生する。
     *
     * 再生が終わって既定モーションへ戻り始めた時点で解決する Promise を返す。
     *
     *   await vrmHumanoid.setAction("Hand Raising");
     *
     * 「待っているのに永久に返らない」状態を作らないため、終わりが定義できない
     * ケースはすべて即座に解決する。
     *   - 既に同じモーションを再生中     … 状態が変わらないので即解決
     *   - 既定モーション（ループ）を指定 … 終わりが無いので即解決
     *   - 再生中に別のモーションを指定   … 中断された側を解決してから切り替える
     *   - 再生中に破棄された             … dispose() が解決する
     * 存在しないモーション名のときだけ reject する（呼び出し側の誤りのため）。
     *
     * @param {string|THREE.AnimationAction} name
     * @param {(event: object) => void} [onFinish] 再生完了時のコールバック
     * @returns {Promise<void>}
     */
    setAction(name, onFinish) {
        const action = (typeof name === "string")
              ? this._actionManager.getAction(name) : name;

        if (! action) {
            return Promise.reject(new Error(
                `モーション "${name}" が見つかりません。読み込み済みか確認してください。`));
        }
        if (action === this._activeAction) {
            return Promise.resolve();
        }

        // 直前のモーションを待っている呼び出し元をここで解放する。
        // 解放しないと、そちらの await が永久に返らない
        this._settleAction();

        const lastAction = this._activeAction;
        this._activeAction = action;
        if (lastAction) {
            lastAction.fadeOut(FADE_TIME);
        }
        action.reset();
        action.fadeIn(FADE_TIME);
        action.clampWhenFinished = true;

        if (action === this._defaultAction) {
            // 既定モーションはループするので "finished" が発火しない
            action.setLoop(THREE.LoopRepeat);
            action.play();
            this._actionManager.onFinish = null;
            return Promise.resolve();
        }

        action.setLoop(THREE.LoopOnce);
        action.play();

        return new Promise((resolve) => {
            this._actionResolve = resolve;
            this._actionManager.onFinish = (event) => {
                // フェードアウト中の前のモーションも "finished" を出すため、
                // 今再生しているモーションのものか確かめる
                if (event.action !== action) {
                    return;
                }
                if (onFinish) {
                    onFinish(event);
                }
                this._actionManager.onFinish = null;
                this._returnToDefaultAction();
                this._settleAction();
            };
        });
    }

    /** 既定モーションへ戻す。 */
    _returnToDefaultAction() {
        if (! this._defaultAction) {
            return;
        }
        this._activeAction = this._defaultAction;
        this._activeAction.setLoop(THREE.LoopRepeat);
        this._activeAction.reset();
        this._activeAction.fadeIn(FADE_TIME);
        this._activeAction.play();
    }

    /** モーション待ちの Promise を解決する。中断・破棄のときも必ず呼ぶこと。 */
    _settleAction() {
        if (! this._actionResolve) {
            return;
        }
        const resolve = this._actionResolve;
        this._actionResolve = null;
        resolve();
    }

    /**
     * 音声を再生する。再生が終わった時点で解決する Promise を返す。
     *
     *   await vrmHumanoid.setSound(arrayBuffer);
     *
     * setAction() と同じく、待っているのに永久に返らない状態を作らない。
     *   - 再生中に別の音声を指定 … 中断された側を解決してから切り替える
     *   - 再生中に破棄された     … dispose() が解決する
     *   - 再生・デコードに失敗   … reject する
     *
     * @param {ArrayBuffer|AudioBuffer|string} resource
     * @returns {Promise<void>}
     */
    setSound(resource) {
        // 直前の音声を待っている呼び出し元をここで解放する
        this._settleSound();

        const promise = new Promise((resolve, reject) => {
            this._soundSettle = {resolve, reject};
        });
        this._audioPlayer.play(resource);
        return promise;
    }

    /**
     * 再生中の音声を止める。
     *
     * setSound() を待っている呼び出し元は、最後まで再生したときと同じく解決する。
     * 中断は意図した操作なので、失敗として扱わない。
     */
    stopSound() {
        this._audioPlayer.stop();
    }

    /**
     * 音声待ちの Promise を解決する。中断・破棄・失敗のときも必ず呼ぶこと。
     * 先に呼ばれたほうを採用する（失敗の直後に完了通知が来ることがあるため）。
     */
    _settleSound(error) {
        if (! this._soundSettle) {
            return;
        }
        const {resolve, reject} = this._soundSettle;
        this._soundSettle = null;
        if (error) {
            reject(error);
        } else {
            resolve();
        }
    }

    _blinkValue(elapsedTime) {
        return (Math.sin(elapsedTime * 1/3) ** 1024) +
            (Math.sin(elapsedTime * 4/7) ** 1024)
    }

    _onPlayStart() {
        this._resetLipSync();
    }

    /**
     * 推定した母音で口形状を、RMS で口の開き具合を決める。
     * @param {{vowel: string|null, confidence: number, rms: number}} result
     */
    _onAnalyzed(result) {
        if (! this._currentVrm) {
            return;
        }

        const isSilent = (result.rms < LIP_SYNC_SILENCE_RMS);

        // 推定が曖昧なときは口形状を変えず、開き具合だけ追従させる（口がばたつくのを防ぐ）
        if (! isSilent && result.vowel && result.confidence >= LIP_SYNC_MIN_CONFIDENCE) {
            this._currentVowel = result.vowel;
        }
        const target = isSilent ? 0 : Math.min(1, result.rms * LIP_SYNC_GAIN);

        const expressionManager = this._currentVrm.expressionManager;
        for (const vowel of Object.keys(LIP_SYNC_PRESETS)) {
            const goal = (vowel === this._currentVowel) ? target : 0;
            const weight = this._lipSyncWeights[vowel]
                  + (goal - this._lipSyncWeights[vowel]) * LIP_SYNC_SMOOTHING;

            this._lipSyncWeights[vowel] = weight;
            expressionManager.setValue(LIP_SYNC_PRESETS[vowel], weight);
        }
        expressionManager.update();
    }

    _onPlayEnd() {
        this._resetLipSync();
        this._settleSound();
    }

    _onPlayError(error) {
        this._resetLipSync();
        this._settleSound(error);
    }

    _resetLipSync() {
        this._currentVowel = "a";
        if (! this._currentVrm) {
            return;
        }
        const expressionManager = this._currentVrm.expressionManager;
        for (const vowel of Object.keys(LIP_SYNC_PRESETS)) {
            this._lipSyncWeights[vowel] = 0;
            expressionManager.setValue(LIP_SYNC_PRESETS[vowel], 0);
        }
        expressionManager.update();
    }


    /**
     * 使い方の例
     * createCustomExpressionMorphTargetBind("Emotion_Joy", {
     *      "Face_Blendshape.Fcl_EYE_Joy": 0.9,
     *      "Face_Blendshape.Fcl_BRW_Joy": 0.9
     * });
     */
    createCustomExpressionMorphTargetBind(name, morphMap) {
        registFaceExpression(this._currentVrm, name, morphMap);
    }

    setFaceExpression(name, value) {
        if (this._currentVrm) {
            this._currentVrm.expressionManager.setValue(name, value);
            this._currentVrm.expressionManager.update();
        }
    }

    /**
     * 表情をすべて 0 に戻す。
     *
     * 名前を 1 つずつ 0 にしていくのと違い、モデルが独自に持つ表情も含めて
     * 確実に戻る。まばたきと口の形は毎フレーム設定し直されるため、
     * これで消しても次のフレームで元通りになる
     */
    resetFaceExpressions() {
        if (this._currentVrm) {
            this._currentVrm.expressionManager.resetValues();
            this._currentVrm.expressionManager.update();
        }
    }
}

export default VrmHumanoid;
