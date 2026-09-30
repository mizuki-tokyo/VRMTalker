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
import GestureLayer from "./gesture-layer.js";
import PoseSway from "./pose-sway.js";

import registFaceExpression from "./vrm-expression-editor.js";

//const FADE_TIME = 0.2;
const FADE_TIME = 0.5;

// ポーズへ移る・ポーズから戻るのにかける時間（秒）。
// 全身の姿勢が変わるので、モーションの切り替えより長めにとる
const POSE_FADE_TIME = 1.0;

// モーションが終わってからこの時間（秒）のうちに次のモーションが来たら、
// 待機へ戻すのを取りやめて、終わったモーションから直接つなぐ。
// 「再生して終わるまで待つ」をくり返すと、次の再生は終わった直後に来る
const CONTINUE_WINDOW = 0.1;

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

    // とっているポーズ（止まったモーション）。無ければ null。
    // モーションを再生し終えたら、既定モーションではなくここへ戻る
    _poseAction = null;

    // ジェスチャー（腕や手だけの上書き）
    _gestureLayer = undefined;

    // ポーズの間の呼吸と小さな揺れ
    _poseSway = undefined;

    // ポーズとして作った action。揺れを足すかどうかの判定に使う
    _poseActions = new WeakSet();

    // 経過時間（秒）。モーションが終わってからの時間を測るのに使う
    _clock = 0;

    // モーションが終わって待機へ戻し始めたところ。{finished, base, at}。
    // この間に次のモーションが来たら、戻すのを取りやめる（_cancelReturn()）
    _returning = null;

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
        this._gestureLayer = new GestureLayer(vrm);
        this._poseSway = new PoseSway(vrm);

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
     * @param {object}  [options]
     * @param {boolean} [options.loop] くり返し再生するモーション（歩く・走るなど）。
     *        最後から最初へのつなぎ目を滑らかにする
     */
    async loadAnimation(url, defaultAction=false, name="", {loop = false} = {}) {
        const action = await this._actionManager.loadAnimation(url, name, {loop});
        if (defaultAction === true) {
            this.setDefaultAction(action);
        }
    }

    /** 読み込み済みのモーション名。 */
    getActionNames() {
        return this._actionManager.getActionNames();
    }

    /**
     * 既定の姿勢（何もしていないときの動き）を決める。ループするモーションか、
     * ポーズ（createPoseAction() で作ったもの）を渡す。
     *
     * 今この姿勢でいるなら、新しいほうへ滑らかに切り替える。モーションの再生中や
     * ポーズをとっている間は切り替えず、そこから戻るときに新しいほうへ戻る
     *
     * @param {THREE.AnimationAction} action
     */
    setDefaultAction(action) {
        const isBase = (! this._activeAction || this._activeAction === this._baseAction);
        this._defaultAction = action;
        action.setLoop(THREE.LoopRepeat);
        if (! isBase || this._baseAction !== action || this._activeAction === action) {
            return;
        }

        const lastAction = this._activeAction;
        this._activeAction = action;
        action.reset();
        if (lastAction) {
            lastAction.fadeOut(POSE_FADE_TIME);
            action.fadeIn(POSE_FADE_TIME);
        }
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
        this._clock += deltaTime;
        if (this._actionManager) {
            this._actionManager.update(deltaTime);
        }

        // モーションが骨を動かした後、VRM へ反映する前に足す・上書きする。
        // 揺れはポーズをとっている間だけ（モーションの再生中は弱めて消す）。
        // ジェスチャーは揺れより後にして、腕と手はジェスチャーを優先する
        const isPosing = this._poseActions.has(this._activeAction);
        this._poseSway?.update(deltaTime, isPosing);
        this._gestureLayer?.update(deltaTime);

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
        this._gestureLayer.clear();

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

        // 終わった直後なら、待機へ戻すのを取りやめて、終わったモーションからつなぐ
        const continued = this._cancelReturn();

        if (action === this._activeAction && ! continued) {
            return Promise.resolve();
        }

        // 直前のモーションを待っている呼び出し元をここで解放する。
        // 解放しないと、そちらの await が永久に返らない
        this._settleAction();

        const lastAction = this._activeAction;
        this._activeAction = action;
        if (lastAction === action) {
            // 終わったばかりの同じモーションをもう一度。切り替えずに頭から続ける。
            // くり返し用のモーション（loop）は最後と最初が同じ姿勢なので、
            // 切れ目なく続いて見える
            action.reset();
        } else {
            if (lastAction) {
                lastAction.fadeOut(FADE_TIME);
            }
            action.reset();
            action.fadeIn(FADE_TIME);
        }
        action.clampWhenFinished = true;

        if (action === this._defaultAction || action === this._poseAction) {
            // 既定モーションとポーズはループするので "finished" が発火しない
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
                this._returnToDefaultAction(action);
                this._settleAction();
            };
        });
    }

    /** 基本の姿勢を返す。ポーズをとっていればそのポーズ、無ければ既定モーション。 */
    get _baseAction() {
        return this._poseAction ?? this._defaultAction;
    }

    /**
     * ポーズ（止まったモーション）をとる。次に setPose(null) するまで保つ。
     *
     *   vrmHumanoid.setPose(vrmHumanoid.createAction(clip));
     *   vrmHumanoid.setPose(null);   // 既定モーションへ戻る
     *
     * ポーズの間に再生したモーションは、終わるとこのポーズへ戻る。
     * モーションの再生中にポーズをとると、モーションは打ち切る（待っている
     * 呼び出し元は解決する）。再生中に setPose(null) したときは打ち切らず、
     * 終わったら既定モーションへ戻るようにだけする
     *
     * @param {THREE.AnimationAction|null} action
     */
    setPose(action) {
        this._returning = null;
        const isBase = (this._activeAction === this._baseAction);
        this._poseAction = action ?? null;
        if (! action && ! isBase) {
            return; // モーションの途中。終わったら既定モーションへ戻る
        }

        const next = this._baseAction;
        if (! next || next === this._activeAction) {
            return;
        }

        // 再生中のモーションを待っている呼び出し元を解放する
        this._actionManager.onFinish = null;
        this._settleAction();

        const lastAction = this._activeAction;
        this._activeAction = next;
        if (lastAction) {
            lastAction.fadeOut(POSE_FADE_TIME);
        }
        next.reset();
        next.setLoop(THREE.LoopRepeat);
        next.fadeIn(POSE_FADE_TIME);
        next.play();
    }

    /**
     * ポーズ（止まったモーション）の AnimationAction を作る。
     * 同じクリップからは同じ action が返る。ポーズの間は呼吸と揺れが足される
     * @param {THREE.AnimationClip} clip
     */
    createPoseAction(clip) {
        const action = this._actionManager.createAction(clip);
        this._poseActions.add(action);
        return action;
    }

    /**
     * ジェスチャーを始める。詳しくは GestureLayer#play() を参照。
     * @returns {Promise<void>} 戻し終えた（または置き換えられた）時点で解決する
     */
    playGesture(rotations, seconds, fadeTime) {
        return this._gestureLayer.play(rotations, seconds, fadeTime);
    }

    /** ジェスチャーをやめる（ゆっくり戻す）。 */
    stopGesture() {
        this._gestureLayer.stop();
    }

    /**
     * 既定モーション（ポーズをとっていればそのポーズ）へ戻す。
     *
     * 終わったモーションは弱めて外す。最後のコマで止めてある（clampWhenFinished）
     * ので、外さないと重み 1 のまま残り、この先のモーションとずっと混ざり続ける
     * （次に再生したモーションの動きが半分ほどに弱まって見える）
     *
     * @param {THREE.AnimationAction} [finishedAction] 終わったモーション
     */
    _returnToDefaultAction(finishedAction) {
        if (! this._baseAction) {
            return;
        }
        if (finishedAction && finishedAction !== this._baseAction) {
            finishedAction.fadeOut(FADE_TIME);
            this._returning = {finished: finishedAction, base: this._baseAction, at: this._clock};
        }
        this._activeAction = this._baseAction;
        this._activeAction.setLoop(THREE.LoopRepeat);
        this._activeAction.reset();
        this._activeAction.fadeIn(FADE_TIME);
        this._activeAction.play();
    }

    /**
     * モーションが終わった直後なら、待機へ戻すのを取りやめる。
     *
     * 終わったモーションを元の重みに戻し、戻り始めた待機の姿勢を外す。
     * 取りやめたら、終わったモーションを今のモーションに戻して返す。
     * そうでなければ（時間がたっている・戻していない）null を返す
     *
     * @returns {THREE.AnimationAction|null}
     */
    _cancelReturn() {
        const returning = this._returning;
        this._returning = null;
        if (! returning || this._clock - returning.at > CONTINUE_WINDOW
            || this._activeAction !== returning.base) {
            return null;
        }
        returning.base.stopFading();
        returning.base.enabled = false; // 次に戻すときは reset() で有効に戻る
        returning.finished.setEffectiveWeight(1); // 弱め始めたのを取りやめる
        this._activeAction = returning.finished;
        return returning.finished;
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
