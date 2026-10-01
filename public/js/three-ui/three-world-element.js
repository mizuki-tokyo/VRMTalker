import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import TweenRunner from "./tween.js";

/**
 * <three-world> : three.js の描画環境（renderer / scene / camera / controls）を
 * ひとつのカスタム要素として提供する。
 *
 * この要素は特定の 3D モデル形式（VRM など）に依存しない。
 * シーンへの追加と毎フレームの更新は、利用側が add() / addUpdateListener() で行う。
 *
 *   const world = document.querySelector("three-world");
 *   world.add(object3D);
 *   world.addUpdateListener((delta, elapsed) => { ... });
 */

// 全インスタンスで 1 枚のスタイルシートを共有する（CSS のパースは 1 回だけ）。
// replace() ではなく replaceSync() を使うこと。replace() は非同期のため、
// connectedCallback で自分のサイズを測る時点で :host のスタイルが未適用になる。
const STYLE_SHEET = new CSSStyleSheet();
STYLE_SHEET.replaceSync(`
  :host {
      display: block;
      position: relative;
  }
  :host([hidden]) {
      display: none;
  }
  canvas {
      display: block;
      width: 100%;
      height: 100%;
  }
`);

const DEFAULT_FOV = 30.0;
const DEFAULT_NEAR = 0.1;
const DEFAULT_FAR = 20.0;
const MAX_PIXEL_RATIO = 2;

// 1フレームあたりの経過時間の上限（秒）。
// 一度に大きく進めると物理演算（スプリングボーン等）が発散する。
// 画面が隠れている間にまとめて進めるときも、この長さずつに刻む
const MAX_DELTA_TIME = 0.1;

// 画面が隠れている間に時間を進める間隔（ミリ秒）。
// ブラウザは隠れたページの requestAnimationFrame を止めるので、代わりに
// setTimeout で進める。ブラウザが間引くため、実際には 1 秒に 1 回ほどになる
const HIDDEN_STEP_INTERVAL = 100;

// 隠れている間に、一度にまとめて進める時間の上限（秒）。
// 長く隠れていると、ブラウザは 1 分に 1 回ほどまで間引くことがある
const MAX_CATCH_UP_TIME = 60;

// setFocus() で範囲を収める際の余白（1.0 でぴったり）
const FRAME_MARGIN = 1.05;

// 影専用の平行光源の向き。
//
// 陰影用の光源 (1,1,1) をそのまま影に使うと、仰角 35 度のため影が身長ぶん
// 横に伸びてしまう。影の目的は「接地感」なので、ほぼ真上から落として
// 足元に溜まるようにする。わずかに傾けているのは真下だと平板に見えるため。
//
// ShadowMaterial の影は getShadowMask() で求まり、光源の intensity を掛けない。
// そのため intensity 0 の光源でも影だけを落とせる（陰影には影響しない）。
const SHADOW_LIGHT_DIRECTION = new THREE.Vector3(0.18, 1.0, 0.28).normalize();

// 平行光源なので距離は影の見た目を変えないが、影用カメラの near/far に効く
const SHADOW_LIGHT_DISTANCE = 5.0;

export default class ThreeWorldElement extends HTMLElement {

    _renderer = null;
    _scene = null;
    _camera = null;
    _controls = null;
    _light = null;
    _shadowLight = null;
    _shadowsEnabled = false;

    _clock = new THREE.Clock();
    _tweenRunner = new TweenRunner();
    _updaters = new Set();
    _running = false;
    _animationFrameId = 0;
    _timeoutId = 0;
    _resizeObserver = null;

    constructor() {
        super();

        const shadowRoot = this.attachShadow({mode: "open"});
        shadowRoot.adoptedStyleSheets = [STYLE_SHEET];

        // renderer
        this._renderer = new THREE.WebGLRenderer({alpha: true, antialias: true});
        this._renderer.setClearColor(0x000000, 0); // transparent background
        this._renderer.outputColorSpace = THREE.SRGBColorSpace;
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
        shadowRoot.appendChild(this._renderer.domElement);

        // scene
        this._scene = new THREE.Scene();

        // camera
        const fov = Number(this.getAttribute("fov")) || DEFAULT_FOV;
        const near = Number(this.getAttribute("near")) || DEFAULT_NEAR;
        const far = Number(this.getAttribute("far")) || DEFAULT_FAR;
        this._camera = new THREE.PerspectiveCamera(fov, 1, near, far);
        this._camera.position.set(0.0, 1.0, 5.0);

        // light
        this._light = new THREE.DirectionalLight(0xffffff);
        this._light.position.set(1.0, 1.0, 1.0).normalize();
        this._scene.add(this._light);
    }

    get renderer() {
        return this._renderer;
    }

    /** シーンを照らす平行光源。影は落とさない（影は専用光源が受け持つ）。 */
    get light() {
        return this._light;
    }

    /** 影専用の平行光源。enableShadows() を呼ぶまでは null。 */
    get shadowLight() {
        return this._shadowLight;
    }

    get scene() {
        return this._scene;
    }

    get camera() {
        return this._camera;
    }

    get controls() {
        return this._controls;
    }

    add(object3D) {
        this._scene.add(object3D);
    }

    remove(object3D) {
        this._scene.remove(object3D);
    }

    /**
     * 注視点（OrbitControls の回転・ズームの中心）を設定する。
     *
     * OrbitControls は常に target を画面中心に置き、ズームは target へ向かって進む。
     * つまり「ズームインしたときに何が見えるか」はここで決まる。
     *
     * @param {THREE.Vector3} target 注視点（ワールド座標）
     * @param {{box?: THREE.Box3, distance?: number}} [options]
     *   box      指定するとその範囲が画面に収まる距離を自動計算する
     *   distance カメラまでの距離を明示する。box より優先される
     */
    setFocus(target, {box = null, distance = null} = {}) {
        const currentTarget = this._controls ? this._controls.target : new THREE.Vector3();

        // 現在の視線方向は保つ（利用者がカメラを回した後でも向きが飛ばない）
        const direction = new THREE.Vector3()
              .subVectors(this._camera.position, currentTarget);
        if (direction.lengthSq() === 0) {
            direction.set(0, 0, 1);
        }
        direction.normalize();

        let cameraDistance = distance;
        if (cameraDistance === null) {
            cameraDistance = box
                ? this._distanceToFit(box, target)
                : this._camera.position.distanceTo(currentTarget);
        }

        this._camera.position.copy(target).addScaledVector(direction, cameraDistance);
        if (this._controls) {
            this._controls.target.copy(target);
            this._controls.update();
        } else {
            this._camera.lookAt(target);
        }
    }

    /**
     * 影の描画を有効にする。
     *
     * 陰影用の光源とは別に、影だけを落とす専用の平行光源を足す。
     * こうする理由は 2 つ。
     *   - 陰影の向きと影の向きを独立に決められる。陰影用の (1,1,1) で影を落とすと
     *     仰角 35 度のため影が横に長く伸び、接地感が出ない
     *   - 光源の向きを変えてもモデルの陰影が変わらない
     *
     * 専用光源は intensity 0 にしてある。ShadowMaterial の影は getShadowMask() で
     * 求まり光源の intensity を掛けないため、明るさに影響を与えずに影だけを落とせる。
     *
     * 何を落とすか（castShadow）と何が受けるか（receiveShadow）は、
     * それぞれのオブジェクト側で指定する。
     */
    enableShadows() {
        if (this._shadowsEnabled) {
            return;
        }
        this._renderer.shadowMap.enabled = true;
        this._renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        // intensity 0 なので陰影には寄与しない。影を落とすためだけの光源
        this._shadowLight = new THREE.DirectionalLight(0xffffff, 0);
        this._shadowLight.position.copy(SHADOW_LIGHT_DIRECTION)
            .multiplyScalar(SHADOW_LIGHT_DISTANCE);
        this._shadowLight.castShadow = true;
        this._shadowLight.shadow.mapSize.set(1024, 1024);
        // 影の輪郭のにじみ。接地感を出すため少しだけぼかす
        this._shadowLight.shadow.radius = 2;

        this._scene.add(this._shadowLight);
        this._scene.add(this._shadowLight.target);

        this._shadowsEnabled = true;
    }

    /**
     * 影用の正射影カメラを、指定した範囲が収まるように調整する。
     *
     * 範囲が広すぎると影の解像度が落ち、狭すぎるとシャドウマップの端が
     * 引き伸ばされて地面に直線状の影が出る。
     *
     * 影が落ちる先も覆う必要があるが、その広がりは光源の向きから計算できるので
     * ここで行う。利用側は「影を落とす対象」の範囲だけ渡せばよい。
     *
     * @param {THREE.Box3} box 影を落とす対象を含む範囲（ワールド座標）
     */
    fitShadowCamera(box) {
        if (! this._shadowsEnabled) {
            return;
        }
        // 光の向きに応じて、影が水平方向へずれる分だけ範囲を広げる。
        // 高さ h の点は (h / dir.y) * dir.xz だけずれた位置に影を落とす
        const height = box.max.y - box.min.y;
        const spread = height / SHADOW_LIGHT_DIRECTION.y;
        const shadowArea = box.clone().expandByVector(new THREE.Vector3(
            Math.abs(SHADOW_LIGHT_DIRECTION.x) * spread,
            0,
            Math.abs(SHADOW_LIGHT_DIRECTION.z) * spread
        ));

        const sphere = shadowArea.getBoundingSphere(new THREE.Sphere());
        const radius = Math.max(sphere.radius, 0.1);

        const shadowCamera = this._shadowLight.shadow.camera;
        shadowCamera.left = -radius;
        shadowCamera.right = radius;
        shadowCamera.top = radius;
        shadowCamera.bottom = -radius;
        shadowCamera.near = 0.1;
        shadowCamera.far = SHADOW_LIGHT_DISTANCE + radius * 2;
        shadowCamera.updateProjectionMatrix();

        // 光源（＝影カメラ）を被写体の中心へ向ける
        this._shadowLight.target.position.copy(sphere.center);
        this._shadowLight.target.updateMatrixWorld();
        this._shadowLight.position.copy(sphere.center)
            .addScaledVector(SHADOW_LIGHT_DIRECTION, SHADOW_LIGHT_DISTANCE);
    }

    /** target を中心に box 全体が画面に収まる距離を求める。 */
    _distanceToFit(box, target) {
        const halfFov = THREE.MathUtils.degToRad(this._camera.fov) / 2;

        // target は box の中心とは限らないので、上下・左右それぞれの遠い側で見る
        const halfHeight = Math.max(box.max.y - target.y, target.y - box.min.y);
        const halfWidth = Math.max(box.max.x - target.x, target.x - box.min.x);

        const byHeight = halfHeight / Math.tan(halfFov);
        const byWidth = halfWidth / (Math.tan(halfFov) * this._camera.aspect);

        return Math.max(byHeight, byWidth) * FRAME_MARGIN;
    }

    /**
     * 値を時間をかけて変化させる（トゥイーン）。描画ループから進むため
     * setTimeout と違ってフレームと同期し、描画が止まれば一緒に止まる。
     *
     *   await world.tween({from: 0, to: 1, duration: 0.3,
     *                      onUpdate: (v) => { ... }});
     *
     * 引数と戻り値は TweenRunner#tween を参照。
     * @returns {Promise<void>} 変化し切った時点で解決する（中断時も解決する）
     */
    tween(options) {
        return this._tweenRunner.tween(options);
    }

    /** 指定した key のトゥイーンを中断する。 */
    cancelTween(key) {
        return this._tweenRunner.cancel(key);
    }

    /**
     * 毎フレーム呼ばれる更新処理を登録する。
     * @param {(delta: number, elapsed: number) => void} updater
     * @returns {() => void} 登録を解除する関数
     */
    addUpdateListener(updater) {
        this._updaters.add(updater);
        return () => {
            this._updaters.delete(updater);
        };
    }

    connectedCallback() {
        // camera controls
        if (! this._controls) {
            this._controls = new OrbitControls(this._camera, this._renderer.domElement);
            this._controls.screenSpacePanning = true;
            this._controls.target.set(0.0, 1.0, 0.0);
            this._controls.update();
        }

        // 要素自身のサイズに追従する（window のサイズではない）
        this._resizeObserver = new ResizeObserver(() => {
            this._resize();
        });
        this._resizeObserver.observe(this);

        this._resize();
        this._start();
    }

    disconnectedCallback() {
        // DOM 内の移動でも呼ばれるため、破棄はせず描画の停止のみ行う
        this._stop();
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
    }

    /** WebGL コンテキストを含めて完全に破棄する（要素を使い捨てる場合のみ） */
    dispose() {
        this._stop();
        this._updaters.clear();
        this._controls?.dispose();
        this._controls = null;
        this._tweenRunner.cancelAll(); // 待っている呼び出し元を残さない
        this._renderer.dispose();
    }

    _resize() {
        const width = this.clientWidth;
        const height = this.clientHeight;
        if (width === 0 || height === 0) {
            return;
        }
        this._camera.aspect = width / height;
        this._camera.updateProjectionMatrix();
        this._renderer.setSize(width, height, false); // 表示サイズは CSS 側に任せる
    }

    /*
      毎フレームの処理（時間を進めて描く）を回す。

      見えている間は requestAnimationFrame で回す。画面が隠れると
      （背面のタブ、最小化、ほかのウィンドウに覆われたときなど）ブラウザは
      requestAnimationFrame を呼ばなくなり、モーションも表情の変化も止まって、
      「終わるまで待つ」が先へ進まなくなる。そこで隠れている間は setTimeout で
      時間だけを進める（描画は見えないので省く）。モーションや表情を動かす側は、
      どちらで回っているかを知らなくてよい
    */
    _start() {
        if (this._running) {
            return;
        }
        this._running = true;
        document.addEventListener("visibilitychange", this._onVisibilityChange);
        this._clock.getDelta(); // 止めていた間の時間は数えない
        this._scheduleNext();
    }

    _stop() {
        this._running = false;
        document.removeEventListener("visibilitychange", this._onVisibilityChange);
        this._cancelNext();
    }

    _onVisibilityChange = () => {
        if (! this._running) {
            return;
        }
        // 見えている・隠れているに合わせて、回し方を切り替える
        this._cancelNext();
        this._scheduleNext();
    };

    _scheduleNext() {
        if (document.hidden) {
            this._timeoutId = setTimeout(() => {
                this._timeoutId = 0;
                this._catchUp();
                this._scheduleNext();
            }, HIDDEN_STEP_INTERVAL);
        } else {
            this._animationFrameId = requestAnimationFrame(() => {
                this._animationFrameId = 0;
                this._render();
                this._scheduleNext();
            });
        }
    }

    _cancelNext() {
        cancelAnimationFrame(this._animationFrameId);
        this._animationFrameId = 0;
        clearTimeout(this._timeoutId);
        this._timeoutId = 0;
    }

    /** 見えているとき：時間を進めて描く。 */
    _render() {
        // delta は複数回取得できないため、ここで一度だけ取得して配る
        const delta = Math.min(this._clock.getDelta(), MAX_DELTA_TIME);
        this._advance(delta, this._clock.elapsedTime);
        this._renderer.render(this._scene, this._camera);
    }

    /**
     * 隠れているとき：前回からの実時間ぶんを、MAX_DELTA_TIME ずつに刻んで進める。
     * 描画はしない（見えないので）。
     */
    _catchUp() {
        let remaining = Math.min(this._clock.getDelta(), MAX_CATCH_UP_TIME);
        const elapsed = this._clock.elapsedTime;
        while (remaining > 0) {
            const delta = Math.min(remaining, MAX_DELTA_TIME);
            this._advance(delta, elapsed);
            remaining -= delta;
        }
    }

    /** 時間を delta 秒進める（トゥイーンと、登録された更新処理）。 */
    _advance(delta, elapsed) {
        // トゥイーンを先に進めてから更新処理を呼ぶ。
        // 表情の値をこのフレームの描画に確実に反映させるため
        this._tweenRunner.update(delta);

        for (const updater of this._updaters) {
            updater(delta, elapsed);
        }
    }
}

window.customElements.define("three-world", ThreeWorldElement);
