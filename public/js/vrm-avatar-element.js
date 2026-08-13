import * as THREE from "three";
import "./three-world-element.js";
import VrmLoader from "./vrm-avatar-element/vrm-loader.js";
import VrmHumanoid from "./vrm-avatar-element/vrm-humanoid.js";
import clampExpressionMorphs from "./vrm-avatar-element/morph-clamp.js";

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

export default class VrmAvatarElement extends HTMLElement {

    _world = null;
    _humanoid = null;
    _removeUpdateListener = null;
    _lookAtInitialized = false;
    _shadowPlane = null;
    _restoreMorphClamp = null;

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

    /** モーション(FBX)を追加で読み込む。 */
    async loadMotion(url, isDefault = false) {
        await this._ready;
        return this._humanoid.loadAnimation(url, isDefault);
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

    /** 表情を即座に設定する。 */
    setExpression(name, value) {
        this._humanoid?.setFaceExpression(name, value);
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
        if (! expressionManager.getExpression(name)) {
            console.warn(`<vrm-avatar>: 表情 "${name}" がモデルにありません。`);
            return;
        }

        return this._world.tween({
            // 現在値から始める。前の変化を中断した場合も途中の値から続く
            from: () => expressionManager.getValue(name) ?? 0,
            to: value,
            duration,
            easing,
            // 同じ表情を二重に動かさないための識別子
            key: `expression:${name}`,
            onUpdate: (weight) => {
                this._humanoid?.setFaceExpression(name, weight);
            }
        });
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

            this._createCustomExpressions(humanoid);
            // 独自表情を登録した後に掛ける（対象モーフを集めるため）
            this._setupMorphClamp(humanoid);
            await this._loadMotions(humanoid);

            this._humanoid = humanoid;
            this._attachToWorld();

            const position = parseVector3(this.getAttribute("position") || "");
            if (position) {
                humanoid.position = position;
            }
            this._addFillLight(humanoid);
            this._setupShadow();
            this.focusCamera();

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

    _createCustomExpressions(humanoid) {
        // Emotion_Joy などの独自表情は、モデルが特定の BlendShape を
        // 持っていることを前提としている。持たないモデルでも動くようにしておく。
        try {
            humanoid.createCustomExpressionMorphTargetBind();
        } catch (error) {
            console.warn("<vrm-avatar>: このモデルには独自表情を登録できませんでした。", error);
        }
    }

    /**
     * カメラの注視点をモデルに合わせる。
     *
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
    _setupMorphClamp(humanoid) {
        const attribute = this.getAttribute("clamp-morphs");
        if (attribute === "off" || attribute === "none") {
            return;
        }
        const value = Number(attribute);
        const max = (attribute !== null && value > 0) ? value : 1.0;

        this._restoreMorphClamp = clampExpressionMorphs(humanoid.vrm, {max});
    }

    _addFillLight(humanoid) {
        const intensity = Number(this.getAttribute("light-intensity"));
        if (! (intensity > 0)) {
            return;
        }
        const light = new THREE.DirectionalLight(0xffffff, intensity);
        light.position.set(1.0, 1.0, 1.0).normalize();
        humanoid.vrm.scene.add(light);
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
