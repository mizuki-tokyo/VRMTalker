import * as THREE from "three";
import "./three-world-element.js";
import VrmLoader from "./vrm-avatar-element/vrm-loader.js";
import VrmHumanoid from "./vrm-avatar-element/vrm-humanoid.js";
import clampExpressionMorphs from "./vrm-avatar-element/morph-clamp.js";
import createMouthMaskedExpressions from "./vrm-avatar-element/mouth-morph-mask.js";
import resolveExpressionName from "./vrm-avatar-element/expression-name.js";
import { poseTemplates, gestureTemplates } from "./vrm-avatar-element/talkinghead-templates.js";
import {
    readTemplate, mirrorRotations, toVrmRotations, toVrmHipsPosition, createPoseClip
} from "./vrm-avatar-element/talkinghead-pose.js";

/**
 * <vrm-avatar> : VRM モデルを <three-world> に配置するカスタム要素。
 *
 * <three-world> の子要素として記述する。それ自体は何も描画しないため、
 * <three-world> の Shadow DOM には slot を置いていない（表示されない）。
 *
 *   <three-world>
 *     <vrm-avatar src="./models/sample.vrm"
 *                 position="0, -0.3, 3.2"
 *                 idle="./fbx/Standing Idle.fbx"
 *                 motions="./fbx/Hand Raising.fbx"></vrm-avatar>
 *   </three-world>
 *
 * 属性
 *   src             : VRM ファイルの URL（必須）
 *   position        : モデルの初期位置 "x, y, z"
 *   idle            : 既定モーション（アイドリング）の FBX の URL
 *   motions         : その他のモーションの FBX の URL。カンマ区切りで複数指定可
 *   light-intensity : モデル用の補助ライトの強さ。0 または未指定なら追加しない
 *   focus           : カメラの注視点にする VRM ヒューマノイドボーン名。既定は "head"。
 *                     "none" を指定すると <three-world> の既定値のまま変更しない
 *   camera-distance : カメラまでの距離。省略するとモデル全体が収まる距離を自動計算する
 *   shadow          : 指定するとモデルが影を落とし、足元の透明な平面がそれを受ける。
 *                     値に 0-1 の数値を書くと影の濃さになる（既定 0.3）
 *   clamp-morphs    : 表情モーフの合計値の上限。既定 1.0。"off" で無効化する。
 *                     複数の表情が同じモーフを使うと合計が 1.0 を超え、
 *                     頂点が意図しない位置まで動くのを防ぐ
 *   mask-mouth-expressions
 *                   : happy などの感情表情から口のモーフを取り除いた版を作り、
 *                     setExpression() / tweenExpression() ではそちらを使う。
 *                     既定で有効。"off" で無効化する。
 *                     感情表情が口を動かすモデルで、その表情のままリップシンクすると
 *                     口の形が崩れるのを防ぐ。口に触れていない表情や、口の形を
 *                     モーフで作っていないモデルでは何もしない
 *
 * 属性の変更
 *   position / focus / camera-distance / shadow / clamp-morphs / light-intensity は、
 *   読み込んだ後に書き換えても画面に反映される。値を消せば既定に戻る。
 *   src / idle / motions / mask-mouth-expressions は読み込むときに一度だけ読む
 *   （モデルの入れ直しになり、実行中の発話や動きの扱いまで決める必要があるため）
 *
 * イベント
 *   progress : 読み込み中。event.detail.value に 0-100
 *   load     : 読み込み完了
 *   error    : 読み込み失敗。event.detail.error に例外
 */

const parseVector3 = (text) => {
    const values = text.split(",").map((value) => Number(value.trim()));
    if (values.length !== 3 || values.some(Number.isNaN)) {
        return undefined;
    }
    return {x: values[0], y: values[1], z: values[2]};
};

const parseUrlList = (text) => {
    return text.split(",")
        .map((url) => url.trim())
        .filter((url) => url.length > 0);
};

// 影を受ける平面の既定の濃さと、モデルの幅に対する広さの倍率
const DEFAULT_SHADOW_OPACITY = 0.3;
const SHADOW_PLANE_SCALE = 3.0;

/** 表情の変化を識別する名前。同じ表情を二重に動かさないために使う。 */
const expressionTweenKey = (name) => `expression:${name}`;

// 立った姿勢と低い姿勢（ひざまずく・座る）の間を移るときに経由するポーズと、
// そこに留まる秒数。TalkingHead と同じ決まり（isPoseDetour() を参照）
const DETOUR_POSE = "oneknee";
const DETOUR_SECONDS = 1.0;

/**
 * from から to へ移るときに、片ひざをつくポーズを経由するか。
 *
 * ポーズの定義に付いている印で決まる。standing（立っている）と lying（低い）の
 * 間を移るときだけ経由する。ポーズの名前の組み合わせは見ない。
 * 名前が null（ポーズではない待機モーション）は、立っているものとして扱う
 */
const isPoseDetour = (from, to) => {
    const kind = (name) => (name === null) ? {standing: true} : (poseTemplates[name] ?? {});
    const a = kind(from), b = kind(to);
    return Boolean(poseTemplates[DETOUR_POSE])
        && Boolean((a.standing && b.lying) || (a.lying && b.standing));
};

export default class VrmAvatarElement extends HTMLElement {

    _world = null;
    _humanoid = null;
    _removeUpdateListener = null;
    _lookAtInitialized = false;
    _shadowPlane = null;
    _restoreMorphClamp = null;
    _fillLight = null;

    // 元の表情名 → 口のモーフを取り除いた版の表情名
    _maskedExpressions = new Map();

    // tweenExpression() で動かしたことのある表情名。
    // clearExpressions() がまとめて止めるために覚えておく
    _tweenedExpressions = new Set();

    // ポーズの名前 → そのポーズの AnimationAction（モデルごとに一度だけ作る）
    _poseActions = new Map();

    // 秒数を決めてとっているポーズの、戻るまでのタイマーと待っている resolve
    _poseWait = null;

    // とっているポーズの名前（null なら待機の姿勢）と、待機の姿勢にしたポーズの名前
    //（null ならポーズではない待機モーション）。片ひざを経由するかの判定に使う
    _currentPose = null;
    _defaultPose = null;

    // 片ひざを経由している間の、本来のポーズへ移るまでのタイマー
    _detourTimer = null;

    _ready = null;
    _resolveReady = null;
    _rejectReady = null;

    constructor() {
        super();
        this._ready = new Promise((resolve, reject) => {
            this._resolveReady = resolve;
            this._rejectReady = reject;
        });
        // error イベントだけを使う場合に unhandled rejection にならないようにする
        this._ready.catch(() => {});
    }

    /** 読み込みが完了すると解決する Promise。値はこの要素自身。 */
    get ready() {
        return this._ready;
    }

    /** 読み込み済みの VrmHumanoid。未読み込みなら null。 */
    get humanoid() {
        return this._humanoid;
    }

    /** 所属する <three-world>。 */
    get world() {
        return this._world;
    }

    get position() {
        return this._humanoid?.position;
    }

    set position(value) {
        if (this._humanoid) {
            this._humanoid.position = value;
        }
    }

    /**
     * モーション（FBX / VRMA）を追加で読み込む。
     *
     * name を指定すると、その名前で playMotion() から呼べるようになる。
     * 画面の選択肢に日本語を出したい場合などに使う。
     *
     *   await avatar.loadMotion("./animations/fbx/Hand Raising.fbx", false, "手を挙げる");
     *   await avatar.playMotion("手を挙げる");
     *
     * @param {string}  url
     * @param {boolean} [isDefault] 既定（ループする待機）モーションにする
     * @param {string}  [name] 登録する名前。省略するとファイル名から作る
     * @param {object}  [options]
     * @param {boolean} [options.loop] くり返し再生するモーション（歩く・走るなど）。
     *        最後から最初へのつなぎ目を滑らかにする。続けて再生すると切れ目なく続く
     */
    async loadMotion(url, isDefault = false, name = "", {loop = false} = {}) {
        await this._ready;
        return this._humanoid.loadAnimation(url, isDefault, name, {loop});
    }

    /**
     * 読み込み済みのモーションの名札。
     *
     * loadMotion() に渡した名前がそのまま返る。このアプリでは
     * animations/motions.json の id を渡しているので、返るのも id
     */
    get motionNames() {
        return this._humanoid ? this._humanoid.getActionNames() : [];
    }

    /**
     * モーションを再生する。終了すると既定モーションへ戻る。
     *
     *   await avatar.playMotion("Hand Raising");
     *
     * 再生の完了を待たない場合は await を付けずに呼べばよい。ただし存在しない
     * モーション名では reject するため、await しないなら .catch() を付けること。
     *
     * @param {string} name モーション名
     * @param {(event: object) => void} [onFinish] 再生完了時のコールバック
     * @returns {Promise<void>} 再生が終わって既定モーションへ戻り始めた時点で解決する
     */
    async playMotion(name, onFinish) {
        await this._ready;
        return this._humanoid.setAction(name, onFinish);
    }

    /**
     * 音声を再生する（口の動きが同期する）。
     * @param {ArrayBuffer|string} resource ArrayBuffer または音声ファイルの URL
     * @returns {Promise<void>} 再生完了で解決する
     */
    async speak(resource) {
        await this._ready;
        return this._humanoid.setSound(resource);
    }

    /**
     * 発話中の音声を止める。
     *
     * 割り込みで話し始めるときや、アクションを中断するときに使う。
     * speak() を待っている呼び出し元は、話し終えたときと同じく解決する。
     */
    stopSpeaking() {
        this._humanoid?.stopSound();
    }

    /**
     * 表情名を、このモデルで実際に使える名前へ解決する。
     *
     * 口マスク版があればそちらを、無い表情なら代替表情を返す。
     * VRM 0.0 / 1.0 のプリセット名の違いは three-vrm が読み込み時に吸収するので、
     * 呼び出し側は VRM 1.0 の名前（happy / angry / sad / relaxed / surprised）
     * だけを書けばよい。
     *
     * @param {string} name
     * @returns {string|null} 使える表情が無ければ null
     */
    resolveExpression(name) {
        return resolveExpressionName(
            this._humanoid?.vrm?.expressionManager, name, this._maskedExpressions);
    }

    /** 表情を即座に設定する。 */
    setExpression(name, value) {
        if (! this._humanoid) {
            return;
        }
        const resolved = this.resolveExpression(name);
        if (! resolved) {
            console.warn(`<vrm-avatar>: 表情 "${name}" がモデルにありません。`);
            return;
        }
        this._humanoid.setFaceExpression(resolved, value);
    }

    /**
     * 表情を徐々に変化させる。変化し切った後はその値を保つ。
     *
     *   await avatar.tweenExpression("Emotion_Joy", 1.0, 0.3);
     *
     * 同じ表情に対して呼び直すと、前の変化はその時点の値から引き継いで置き換わる。
     * 中断された場合も Promise は解決する（await が返らなくならないように）。
     *
     * @param {string} name 表情名
     * @param {number} value 目標値 (0-1)
     * @param {number} [duration] 所要時間（秒）。0 以下なら即座に設定する
     * @param {string|((t: number) => number)} [easing] "linear" | "easeIn" | "easeOut" | "easeInOut"
     * @returns {Promise<void>} 変化し切った時点で解決する
     */
    async tweenExpression(name, value, duration = 0.3, easing = "easeInOut") {
        await this._ready;

        const expressionManager = this._humanoid.vrm.expressionManager;
        // 解決は一度だけ行い、以降は同じ名前を使う。
        // 途中で名前が変わると、値の読み出しと書き込みがずれてしまう
        const resolved = this.resolveExpression(name);
        if (! resolved) {
            console.warn(`<vrm-avatar>: 表情 "${name}" がモデルにありません。`);
            return;
        }

        this._tweenedExpressions.add(resolved);

        return this._world.tween({
            // 現在値から始める。前の変化を中断した場合も途中の値から続く
            from: () => expressionManager.getValue(resolved) ?? 0,
            to: value,
            duration,
            easing,
            key: expressionTweenKey(resolved),
            onUpdate: (weight) => {
                this._humanoid?.setFaceExpression(resolved, weight);
            }
        });
    }

    /**
     * 表情をすべて 0 に戻す。
     *
     *   avatar.clearExpressions();
     *
     * 変化の途中のものはその場で打ち切る。打ち切らないと、次のフレームで
     * 元の値が書き戻されてしまう
     */
    clearExpressions() {
        if (! this._humanoid) {
            return;
        }
        for (const name of this._tweenedExpressions) {
            this._world?.cancelTween(expressionTweenKey(name));
        }
        this._tweenedExpressions.clear();
        this._humanoid.resetFaceExpressions();
    }

    /**
     * 表情を出して、一定時間保ってから元に戻す。
     *
     *   await avatar.playExpression("Emotion_Joy", {hold: 2.0});
     *
     * @param {string} name 表情名
     * @param {object} [options]
     * @param {number} [options.value]    保つ値 (0-1)
     * @param {number} [options.fadeIn]   出るまでの時間（秒）
     * @param {number} [options.hold]     保つ時間（秒）
     * @param {number} [options.fadeOut]  戻るまでの時間（秒）
     * @returns {Promise<void>} 元に戻り切った時点で解決する
     */
    async playExpression(name, {value = 1.0, fadeIn = 0.2, hold = 1.0, fadeOut = 0.4} = {}) {
        await this.tweenExpression(name, value, fadeIn);
        if (hold > 0) {
            await new Promise((resolve) => setTimeout(resolve, hold * 1000));
        }
        await this.tweenExpression(name, 0, fadeOut);
    }

    /** 後から変えても反映する属性。ここに無いものは読み込むときの一度きり。 */
    static get observedAttributes() {
        return ["position", "focus", "camera-distance",
                "shadow", "clamp-morphs", "light-intensity"];
    }

    /**
     * 属性が書き換えられたとき。
     *
     * 読み込みが済むまでは何もしない。この呼び出しは connectedCallback より
     * **先に**来るため（HTML に書いてある属性は要素ができた時点で 1 つずつ
     * 通知される）、まだモデルが無い。最初の値は _load() がまとめて適用する
     */
    attributeChangedCallback(name, oldValue, newValue) {
        if (! this._humanoid || oldValue === newValue) {
            return;
        }
        this._applyAttribute(name);
    }

    /**
     * 属性 1 つぶんを画面へ反映する。
     *
     * 読み込みのときも同じ関数を通す。2 通りの経路があると、片方だけ直した
     * ときに食い違うため（_applyAttributes() を参照）
     */
    _applyAttribute(name) {
        switch (name) {
        case "position":
            this._applyPosition();
            break;
        case "focus":
        case "camera-distance":
            this.focusCamera();
            break;
        case "shadow":
            this._setupShadow();
            break;
        case "clamp-morphs":
            this._setupMorphClamp();
            break;
        case "light-intensity":
            this._applyFillLight();
            break;
        }
    }

    /** 反映できる属性をすべて適用する。読み込みの最後に呼ぶ。 */
    _applyAttributes() {
        for (const name of this.constructor.observedAttributes) {
            this._applyAttribute(name);
        }
    }

    connectedCallback() {
        this.style.display = "none";

        if (this._humanoid) {
            // DOM 内を移動した場合は、読み込み直さず接続先の <three-world> に入れ直す
            this._attachToWorld();
            return;
        }
        this._load();
    }

    disconnectedCallback() {
        this._detachFromWorld();

        // DOM 内の移動でも呼ばれるため、本当に外されたのかを次のタスクで判定する
        setTimeout(() => {
            if (! this.isConnected) {
                this.dispose();
            }
        }, 0);
    }

    /** モデルを破棄する。以降この要素は再利用できない。 */
    dispose() {
        this._detachFromWorld();
        this._removeShadowPlane();
        this._restoreMorphClamp?.();
        this._restoreMorphClamp = null;
        this._maskedExpressions = new Map();
        this._tweenedExpressions.clear();
        this._settlePose();
        this._cancelDetour();
        this._poseActions = new Map();
        this._currentPose = null;
        this._defaultPose = null;
        // 光源はモデルの scene に入れてあるので、モデルと一緒に消える
        this._fillLight = null;
        this._humanoid?.dispose();
        this._humanoid = null;
        this._lookAtInitialized = false;
    }

    async _load() {
        try {
            const src = this.getAttribute("src");
            if (! src) {
                throw new Error("<vrm-avatar> に src 属性が指定されていません。");
            }

            await window.customElements.whenDefined("three-world");
            this._world = this.closest("three-world");
            if (! this._world) {
                throw new Error("<vrm-avatar> は <three-world> の子要素として配置してください。");
            }

            const vrm = await VrmLoader.load(src, (value) => {
                this.dispatchEvent(new CustomEvent("progress", {detail: {value}}));
            });

            const humanoid = new VrmHumanoid(vrm);
            if (! this.isConnected) {
                // 読み込み中に DOM から外された
                humanoid.dispose();
                return;
            }

            this._setupMouthMask(humanoid);
            await this._loadMotions(humanoid);

            this._humanoid = humanoid;
            this._attachToWorld();

            // 位置・影・光・注視点・モーフの上限は、後から属性を書き換えた
            // ときと同じ道を通す。表情をすべて登録した後になるのも都合がよい
            // （モーフの上限は対象のモーフを集めるため）
            this._applyAttributes();

            this._resolveReady(this);
            this.dispatchEvent(new CustomEvent("load"));

        } catch (error) {
            this._rejectReady(error);
            this.dispatchEvent(new CustomEvent("error", {detail: {error}}));
        }
    }

    async _loadMotions(humanoid) {
        const idle = this.getAttribute("idle");
        if (idle) {
            // 既定モーション（アイドリングモーション）
            await humanoid.loadAnimation(idle, true);
        }
        for (const url of parseUrlList(this.getAttribute("motions") || "")) {
            await humanoid.loadAnimation(url);
        }
    }


    /**
     * 感情表情から口のモーフを取り除いた版を作る。
     *
     * リップシンク中もその表情を出せるようにするため。作られた表情は
     * setExpression() / tweenExpression() が自動で使う（resolveExpression() 参照）。
     */
    _setupMouthMask(humanoid) {
        const attribute = this.getAttribute("mask-mouth-expressions");
        if (attribute === "off" || attribute === "none") {
            return;
        }
        try {
            this._maskedExpressions = createMouthMaskedExpressions(humanoid.vrm);
        } catch (error) {
            // 表情が作れなくても元の表情でそのまま動く
            console.warn("<vrm-avatar>: 口マスク版の表情を作成できませんでした。", error);
            this._maskedExpressions = new Map();
        }
    }

    /**
     * 視線（目の向き）。
     *
     * 動かすのは目だけで、頭は回らない（VRM の lookAt はそう決まっている）。
     * 指定した角度はモデル側の範囲へ圧縮されるため、見た目の角度とは一致しない
     * ことに注意。同梱のモデルでは、45 度を指定して目は 7 度ほど動く
     */
    get _lookAt() {
        const lookAt = this._humanoid?.vrm?.lookAt;
        // 滑らかに動かす版に差し替わっていなければ、視線は触らない
        return (typeof lookAt?.setGaze === "function") ? lookAt : null;
    }

    /** 視線でカメラを追いかける（読み込んだ直後の状態）。 */
    gazeFollowCamera() {
        this._lookAt?.follow(this._world?.camera ?? null);
    }

    /** 視線をカメラへ向けて、そこで止める。カメラが動いても付いていかない。 */
    gazeAtCamera() {
        const camera = this._world?.camera;
        if (! camera) {
            return;
        }
        this._lookAt?.gazeAt(camera.getWorldPosition(new THREE.Vector3()));
    }

    /**
     * 視線を向ける。向きは**画面から見た**ほう。
     *
     *   avatar.gazeTo("right", 45);   // 画面の右へ
     *
     * @param {string} direction "right" | "left" | "up" | "down" | "front"
     * @param {number} [degrees] 見込みの角度。front のときは使わない
     */
    gazeTo(direction, degrees = 30) {
        const amount = Math.abs(Number(degrees)) || 0;
        // three-vrm の決まりに合わせる（yaw＋が画面の右、pitch＋が下）
        const angles = {
            right: [amount, 0],
            left: [-amount, 0],
            up: [0, -amount],
            down: [0, amount],
            front: [0, 0]
        }[String(direction)];

        if (! angles) {
            console.warn(`<vrm-avatar>: 視線の向き "${direction}" は扱えません。`);
            return;
        }
        this._lookAt?.setGaze(angles[0], angles[1]);
    }

    /**
     * ポーズとジェスチャー。
     *
     * 定義は TalkingHead（https://github.com/met4citizen/TalkingHead）のもので、
     * 名前もその名前で指定する（talkinghead-templates.js）。
     *
     *   ポーズ        全身の姿勢（立ち方・座り方）。待機モーションの代わりになる
     *   ジェスチャー  腕と手だけの身ぶり。モーションやポーズの上から重ねる
     */

    /** 使えるポーズの名前。 */
    static get poseNames() {
        return Object.keys(poseTemplates);
    }

    /** 使えるジェスチャーの名前。 */
    static get gestureNames() {
        return Object.keys(gestureTemplates);
    }

    /**
     * ポーズをとる。
     *
     *   await avatar.takePose("sitting");   // 次の指示まで座ったまま
     *   await avatar.takePose("hip", 5);    // 5 秒たったら待機モーションへ戻る
     *   await avatar.takePose(null);        // 待機モーションへ戻る
     *
     * ポーズの間に再生したモーションは、終わるとポーズへ戻る。
     * 秒数を決めてとっている途中で別のポーズをとると、前のほうの待ちは解決する。
     * 立った姿勢と低い姿勢（ひざまずく・座る）の間は、片ひざをつくポーズを
     * 1 秒経由して移る（isPoseDetour() を参照）。
     *
     * @param {string|null} name ポーズの名前。null なら待機モーションへ戻る
     * @param {number} [seconds] 保つ秒数。省略するとずっと
     * @returns {Promise<void>} 秒数を決めたときは、戻り始めた時点で解決する。
     *          決めないときは、ポーズへ移り始めた時点で解決する
     */
    async takePose(name, seconds = Infinity) {
        await this._ready;
        this._settlePose();

        if (name === null || name === undefined) {
            this._changePose(null);
            return;
        }
        this._changePose(String(name));

        if (! Number.isFinite(Number(seconds))) {
            return;
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this._poseWait = null;
                this._changePose(null);
                resolve();
            }, Math.max(0, Number(seconds)) * 1000);
            this._poseWait = {timer, resolve};
        });
    }

    /**
     * ポーズを切り替える。必要なら片ひざをつくポーズを経由する。
     * @param {string|null} name ポーズの名前。null なら待機の姿勢へ戻る
     */
    _changePose(name) {
        if (! this._humanoid) {
            return;
        }
        const action = (name === null) ? null : this._poseAction(name); // 知らない名前はここで投げる

        // 経由している途中なら、今いるのは片ひざの姿勢
        const from = (this._detourTimer !== null)
            ? DETOUR_POSE
            : (this._currentPose ?? this._defaultPose);
        this._cancelDetour();
        const to = name ?? this._defaultPose;
        this._currentPose = name;

        if (! isPoseDetour(from, to)) {
            this._humanoid.setPose(action);
            return;
        }
        this._humanoid.setPose(this._poseAction(DETOUR_POSE));
        this._detourTimer = setTimeout(() => {
            this._detourTimer = null;
            this._humanoid?.setPose(action);
        }, DETOUR_SECONDS * 1000);
    }

    /** 片ひざを経由している途中なら、本来のポーズへ移るのを取りやめる。 */
    _cancelDetour() {
        if (this._detourTimer !== null) {
            clearTimeout(this._detourTimer);
            this._detourTimer = null;
        }
    }

    /** 秒数を決めたポーズのタイマーを止め、待っている呼び出し元を解決する。 */
    _settlePose() {
        if (! this._poseWait) {
            return;
        }
        const {timer, resolve} = this._poseWait;
        this._poseWait = null;
        clearTimeout(timer);
        resolve();
    }

    /** ポーズの action を返す。初めてのポーズなら、このモデル用に作る。 */
    _poseAction(name) {
        let action = this._poseActions.get(name);
        if (action) {
            return action;
        }
        const template = poseTemplates[name];
        if (! template) {
            throw new Error(`ポーズ "${name}" はありません。`);
        }
        const vrm = this._humanoid.vrm;
        const {rotations, hipsPosition} = readTemplate(template.props);
        const clip = createPoseClip(
            `pose:${name}`,
            toVrmRotations(rotations, vrm),
            hipsPosition ? toVrmHipsPosition(hipsPosition, vrm) : null,
            vrm);
        action = this._humanoid.createPoseAction(clip);
        this._poseActions.set(name, action);
        return action;
    }

    /**
     * 何もしていないときの姿勢を、ポーズにする（呼吸と小さな揺れが付く）。
     *
     *   await avatar.setDefaultPose("straight");
     *
     * 待機モーション（motions.json の default）の代わりに使う。モーションが
     * 終わったとき・ポーズをやめたときに戻るのがこの姿勢になる
     *
     * @param {string} name ポーズの名前
     */
    async setDefaultPose(name) {
        await this._ready;
        this._humanoid.setDefaultAction(this._poseAction(String(name)));
        this._defaultPose = String(name);
    }

    /**
     * ジェスチャーをする。
     *
     *   await avatar.playGesture("thumbup", {hand: "right", seconds: 3});
     *
     * 1 秒かけて寄せ、始めてから seconds 秒たったら 1 秒かけて戻す。
     * 範囲で決められた値は、そのたびにばらつかせる（毎回少し違う動きになる）。
     *
     * @param {string} name ジェスチャーの名前
     * @param {object} [options]
     * @param {string} [options.hand] "right" | "left"。アバター自身から見た手
     *        （画面では左右が逆に見える）。両手のジェスチャーでは左右が入れ替わる
     * @param {number} [options.seconds] 始めてから戻し始めるまでの秒数
     * @returns {Promise<void>} 戻し終えた時点で解決する。別のジェスチャーに
     *          置き換えられたときも解決する
     */
    async playGesture(name, {hand = "right", seconds = 3} = {}) {
        await this._ready;
        const template = gestureTemplates[String(name)];
        if (! template) {
            throw new Error(`ジェスチャー "${name}" はありません。`);
        }
        let {rotations} = readTemplate(template);
        // 片手のジェスチャーは左手で定義されているので、右手は左右を入れ替えて作る
        if (hand === "right") {
            rotations = mirrorRotations(rotations);
        }
        return this._humanoid.playGesture(toVrmRotations(rotations, this._humanoid.vrm), seconds);
    }

    /** ジェスチャーをやめる（1 秒かけて戻す）。 */
    stopGesture() {
        this._humanoid?.stopGesture();
    }

    /**
     * カメラの注視点をモデルに合わせる。
     *
     * これはカメラの話で、視線（gazeTo など）とは別。
     * VRM 仕様では head などのヒューマノイドボーンが必須なので、
     * ボーン名で指定すればモデルを差し替えても同じ位置を狙える。
     *
     * @param {string} [boneName] 省略時は focus 属性（既定 "head"）
     */
    focusCamera(boneName) {
        const focus = boneName || this.getAttribute("focus") || "head";
        if (focus === "none" || ! this._humanoid || ! this._world) {
            return;
        }

        const vrm = this._humanoid.vrm;
        const bone = vrm.humanoid.getRawBoneNode(focus);
        if (! bone) {
            console.warn(`<vrm-avatar>: ボーン "${focus}" が見つかりません。`
                         + `注視点の設定をスキップします。`);
            return;
        }

        // ボーンのワールド座標を得るため、変換行列を最新にしておく
        vrm.scene.updateWorldMatrix(true, true);
        const target = bone.getWorldPosition(new THREE.Vector3());

        const distance = this.getAttribute("camera-distance");
        if (distance) {
            this._world.setFocus(target, {distance: Number(distance)});
        } else {
            this._world.setFocus(target, {box: this._boundingBox()});
        }
    }

    /**
     * 影を設定する。
     *
     * モデルのメッシュに castShadow を立て、足元に影だけを描画する透明な平面を置く。
     * 平面の位置と大きさはモデルのバウンディングボックスから決めるので、
     * 体格の違うモデルに差し替えても足元に合う。
     */
    _setupShadow() {
        // 掛け直せるように、前の板を必ず外してから始める。
        // 属性を消したときは板が無くなるので影も出なくなる（影を受けるものが
        // 無くなるため）。描画側の影の設定と castShadow は残るが、見た目には
        // 出ない
        this._removeShadowPlane();
        if (! this.hasAttribute("shadow")) {
            return;
        }
        this._world.enableShadows();

        // VRM のメッシュが影を落とすようにする。
        // receiveShadow は付けない（モデル自身に落ちる影はトゥーン表現と相性が悪い）
        this._humanoid.vrm.scene.traverse((object) => {
            if (object.isMesh) {
                object.castShadow = true;
            }
        });

        const box = this._boundingBox();
        const size = box.getSize(new THREE.Vector3());

        // 影が板の外へ出ないよう、モデルの幅に対して余裕を持たせる。
        // 影専用光源はほぼ真上から落とすので、身長ぶんまでの余裕は要らない
        const planeSize = Math.max(size.x, size.z) * SHADOW_PLANE_SCALE;

        const value = Number(this.getAttribute("shadow"));
        const opacity = (value > 0 && value <= 1) ? value : DEFAULT_SHADOW_OPACITY;

        // ShadowMaterial は落ちてきた影だけを描画する。板そのものは見えない
        this._shadowPlane = new THREE.Mesh(
            new THREE.PlaneGeometry(planeSize, planeSize),
            new THREE.ShadowMaterial({opacity, transparent: true})
        );
        this._shadowPlane.rotation.x = -Math.PI / 2; // 水平にする
        this._shadowPlane.position.set(box.min.x + size.x / 2, box.min.y, box.min.z + size.z / 2);
        this._shadowPlane.receiveShadow = true;
        // 影を受けるだけなので、影の描画対象からは外す
        this._shadowPlane.castShadow = false;

        this._world.add(this._shadowPlane);

        // 影が落ちる範囲まで含めた調整は <three-world> 側で行う（光源の向きが必要なため）
        this._world.fitShadowCamera(box);
    }

    _removeShadowPlane() {
        if (! this._shadowPlane) {
            return;
        }
        this._world?.remove(this._shadowPlane);
        this._shadowPlane.geometry.dispose();
        this._shadowPlane.material.dispose();
        this._shadowPlane = null;
    }

    /** モデル全体のバウンディングボックス（ワールド座標）。 */
    _boundingBox() {
        const box = new THREE.Box3();
        this._humanoid.vrm.scene.traverse((object) => {
            if (! object.isMesh || ! object.geometry) {
                return;
            }
            // frustumCulled を切っているため boundingBox は自前で計算する
            object.geometry.computeBoundingBox();
            box.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
        });
        return box;
    }

    /**
     * 表情モーフの限界突破を防ぐ。
     *
     * three-vrm は複数の表情が同じモーフを指すと単純に加算するため、
     * 合計が 1.0 を超えて頂点が意図しない位置まで動くことがある。
     * VRM 仕様の overrideBlink は VRM 0.0 では使えず blink/lookAt/mouth しか
     * 救えないので、モデルに依存しない安全網として既定で有効にしている。
     */
    _setupMorphClamp() {
        // 掛け直せるように、前のものを必ず外してから始める
        this._restoreMorphClamp?.();
        this._restoreMorphClamp = null;

        const attribute = this.getAttribute("clamp-morphs");
        if (attribute === "off" || attribute === "none") {
            return;
        }
        const value = Number(attribute);
        const max = (attribute !== null && value > 0) ? value : 1.0;

        this._restoreMorphClamp = clampExpressionMorphs(this._humanoid.vrm, {max});
    }

    /** 補助ライトを付け直す。外さずに足すと明るさが積み重なる。 */
    _applyFillLight() {
        if (this._fillLight) {
            this._fillLight.removeFromParent();
            this._fillLight.dispose();
            this._fillLight = null;
        }
        const intensity = Number(this.getAttribute("light-intensity"));
        if (! (intensity > 0)) {
            return;
        }
        const light = new THREE.DirectionalLight(0xffffff, intensity);
        light.position.set(1.0, 1.0, 1.0).normalize();
        this._humanoid.vrm.scene.add(light);
        this._fillLight = light;
    }

    /**
     * 位置を属性に合わせる。
     *
     * 属性を消したら元の位置（原点）へ戻す。属性に書いてあるとおりの場所に
     * いる、という状態にしておく
     */
    _applyPosition() {
        const text = this.getAttribute("position");
        if (text === null) {
            this._humanoid.position = {x: 0, y: 0, z: 0};
            return;
        }
        const position = parseVector3(text);
        if (! position) {
            console.warn(`<vrm-avatar>: position="${text}" を読み取れません。`
                         + `"x, y, z" の形で書いてください。`);
            return;
        }
        this._humanoid.position = position;
    }

    _attachToWorld() {
        this._detachFromWorld();

        this._world = this.closest("three-world");
        if (! this._world || ! this._humanoid) {
            return;
        }
        this._world.add(this._humanoid.vrm.scene);
        if (this._shadowPlane) {
            this._world.add(this._shadowPlane);
        }

        if (! this._lookAtInitialized) {
            // lookAt の差し替えは一度だけ行う（複数回行うと入れ子になる）
            this._humanoid.lookAtTarget = this._world.camera;
            this._lookAtInitialized = true;
        }
        this._removeUpdateListener = this._world.addUpdateListener((delta, elapsed) => {
            this._humanoid.update(delta, elapsed);
        });
    }

    _detachFromWorld() {
        if (this._removeUpdateListener) {
            this._removeUpdateListener();
            this._removeUpdateListener = null;
        }
        if (this._world && this._humanoid) {
            this._world.remove(this._humanoid.vrm.scene);
        }
        if (this._world && this._shadowPlane) {
            this._world.remove(this._shadowPlane);
        }
    }
}

window.customElements.define("vrm-avatar", VrmAvatarElement);
