import * as THREE from "three";
import "./vrm-avatar-element.js";

/**
 * アバターの頭の上に絵を出すカスタム要素の、共通の土台。
 *
 * <vrm-emote>（感情アイコン）と <vrm-thinking>（考え中の吹き出し）が継承する。
 * 頭に付いて回ること、出入りのフェード、読み込みと後片付けをここで受け持ち、
 * 派生側は「どの絵をいつ出すか」だけを書く。
 *
 * <vrm-avatar> の子要素として記述する。それ自体は何も描画しないため、
 * 表示は none にしてある。
 *
 * 属性（既定値は派生側の static で決める）
 *   size   : 絵の高さ（メートル）
 *   offset : 頭のワールド座標からのずれ "x, y, z"
 *   bone   : 追従する VRM ヒューマノイドボーン名
 *   fade   : 出入りにかける秒数
 *   pop    : 付けると、出るときに少し小さいところから膨らみ、消えるときに
 *            少し縮む（不透明度の変化に合わせる）。値はいちばん小さいときの
 *            倍率で、省くと 0.85。外せば大きさは変えない
 *
 *              <vrm-thinking pop></vrm-thinking>         0.85 倍から
 *              <vrm-thinking pop="0.7"></vrm-thinking>   0.7 倍から
 *
 * イベント
 *   load  : 読み込み完了
 *   error : 読み込み失敗。event.detail.error に例外
 *
 * 派生側が上書きするもの
 *   static defaultSize / defaultOffset / defaultBone / defaultFade
 *   _loadTextures()      絵を読み込む（モデルを待たずに呼ばれる）
 *   _onLoadFailed(error) 読み込みに失敗したとき
 *   _disposeTextures()   絵を破棄する
 *   _onFrame(delta)      出ている間、毎フレーム呼ばれる
 *
 *
 * なぜ Sprite なのか
 * ------------------
 * 板（PlaneGeometry）を置くと、親の回転をそのまま受け継ぐ。アバターが横を
 * 向けば絵も裏を向き、首をかしげれば傾く。毎フレーム打ち消す処理が要る。
 * Sprite はシェーダ側でビルボード処理されるので、常にカメラを向く。
 * 材質が無照明なのも都合が良く、シーンのライトで絵が暗くならない。
 *
 * なぜ頭ボーンの子にしないのか
 * ----------------------------
 * Sprite でも、ボーンの子にすると位置のずれ（offset）が頭と一緒に回る。
 * 真上に出したつもりが、首をかしげた瞬間に横へずれる。
 * ここでは頭の「ワールド座標」だけを毎フレーム借りて、ずれはワールド座標で
 * 足している。頭がどちらを向いても絵は真上に留まる。
 *
 * DOM の入れ子は「どのアバターのものか」を表すだけで、three.js の親子関係
 * とは一致しない。
 */

// モデルより手前に描く。髪の毛に絵がめり込むのを防ぐ
const RENDER_ORDER = 10;

// pop 属性に値が無いときの、いちばん小さいときの倍率
const DEFAULT_POP_SCALE = 0.85;

const parseVector3 = (text) => {
    const values = text.split(",").map((value) => Number(value.trim()));
    if (values.length !== 3 || values.some(Number.isNaN)) {
        return undefined;
    }
    return {x: values[0], y: values[1], z: values[2]};
};


export default class VrmHeadSpriteElement extends HTMLElement {

    static defaultSize = 0.28;
    static defaultOffset = [0, 0.28, 0];
    static defaultBone = "head";
    static defaultFade = 0.15;

    _avatar = null;
    _world = null;
    _bone = null;
    _sprite = null;
    _removeUpdateListener = null;

    // 表示のたびに増やす。古い表示の処理が新しい表示を消さないようにする
    _generation = 0;

    _ready = null;
    _resolveReady = null;
    _rejectReady = null;

    // 頭の位置を毎フレーム受け取る入れ物。フレームごとに作らない
    _worldPosition = new THREE.Vector3();

    // offset 属性を解釈したもの。毎フレーム読み直さないよう持っておく
    _offset = new THREE.Vector3();

    // 絵の本来の大きさ（幅・高さ。メートル）。pop で縮めるときの元になる
    _baseScale = new THREE.Vector2(1, 1);

    constructor() {
        super();
        this._offset.set(...this.constructor.defaultOffset);
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

    connectedCallback() {
        this.style.display = "none";

        if (this._sprite) {
            // DOM 内を移動した場合は読み込み直さない
            this._attach();
            return;
        }
        this._load();
    }

    disconnectedCallback() {
        this._detach();

        // DOM 内の移動でも呼ばれるため、本当に外されたのかを次のタスクで判定する
        setTimeout(() => {
            if (! this.isConnected) {
                this.dispose();
            }
        }, 0);
    }

    /** 絵を破棄する。以降この要素は再利用できない。 */
    dispose() {
        this._detach();
        this._disposeTextures();
        this._sprite?.material.dispose();
        this._sprite = null;
        this._bone = null;
    }

    //---------------------------------- 派生側が上書きするもの

    /** 絵を読み込む。モデルの読み込みを待たずに呼ばれる。 */
    async _loadTextures() {}

    /** 読み込みに失敗したとき。 */
    _onLoadFailed(error) {}

    /** 絵を破棄する。 */
    _disposeTextures() {}

    /** 出ている間、毎フレーム呼ばれる。delta は前のフレームからの秒数。 */
    _onFrame(delta) {}

    //---------------------------------- 派生側から使うもの

    /**
     * 絵を差し替えて出す（フェードイン）。出し終えると解決する。
     * @param {THREE.Texture} texture
     * @param {number} aspect 幅 / 高さ
     * @param {number} generation この表示の世代（++this._generation したもの）
     */
    async _appear(texture, aspect, generation) {
        this._setTexture(texture, aspect);
        // 出る前に頭の位置へ移しておく。前の絵の位置から飛んでこない
        this._updateOffset();
        this._followHead();
        this._sprite.visible = true;
        await this._fadeTo(1, generation);
    }

    /** 出している絵を差し替える（フェードはしない）。 */
    _setTexture(texture, aspect) {
        const material = this._sprite.material;
        if (material.map !== texture) {
            material.map = texture;
            material.needsUpdate = true;
        }
        const size = this._size();
        this._baseScale.set(size * aspect, size);
        this._applyScale();
    }

    /**
     * 大きさを反映する。pop 属性があれば、不透明度に合わせて縮める
     * （透明なときに pop の倍率、不透明なときに本来の大きさ）。
     * 不透明度と同じ tween で動くので、緩急もフェードと揃う
     */
    _applyScale() {
        const popScale = this._popScale();
        const factor = popScale + (1 - popScale) * this._sprite.material.opacity;
        this._sprite.scale.set(this._baseScale.x * factor, this._baseScale.y * factor, 1);
    }

    /** 消す（フェードアウト）。消え終わると解決する。 */
    async _hide(generation) {
        if (! this._sprite?.visible) {
            return;
        }
        await this._fadeTo(0, generation);
        if (generation === this._generation) {
            this._sprite.visible = false;
        }
    }

    //---------------------------------- 内部

    async _load() {
        try {
            await window.customElements.whenDefined("vrm-avatar");
            this._avatar = this.closest("vrm-avatar");
            if (! this._avatar) {
                throw new Error(`<${this.localName}> は <vrm-avatar> の子要素として配置してください。`);
            }

            // 絵はモデルと関わりが無いので、先に用意する
            await this._loadTextures();

            // ここから先はモデルが要る。頭のボーンは読み終えるまで存在しない
            await this._avatar.ready;

            this._sprite = new THREE.Sprite(new THREE.SpriteMaterial({
                transparent: true,
                // 深度を見ないことで、髪などモデルの一部に隠れなくなる
                depthTest: false,
                depthWrite: false,
                opacity: 0
            }));
            this._sprite.renderOrder = RENDER_ORDER;
            this._sprite.visible = false;

            if (! this.isConnected) {
                this.dispose();
                return;
            }
            this._attach();

            this._resolveReady(this);
            this.dispatchEvent(new CustomEvent("load"));

        } catch (error) {
            this._onLoadFailed(error);
            this._rejectReady(error);
            this.dispatchEvent(new CustomEvent("error", {detail: {error}}));
            console.warn(`<${this.localName}> の読み込みに失敗しました`, error);
        }
    }

    _attach() {
        if (! this._sprite || this._removeUpdateListener) {
            return;
        }
        this._world = this._avatar.world;
        const vrm = this._avatar.humanoid?.vrm;
        this._bone = vrm?.humanoid?.getRawBoneNode(this._boneName());

        if (! this._world || ! this._bone) {
            console.warn(`<${this.localName}>: ボーン "${this._boneName()}" が見つかりません。`
                         + `頭の上の絵は表示されません`);
            return;
        }

        // Sprite はシーンに直接置く。頭のワールド座標だけを毎フレーム借りる
        this._updateOffset();
        this._world.add(this._sprite);
        this._removeUpdateListener = this._world.addUpdateListener((delta) => {
            if (this._sprite.visible) {
                this._followHead();
                this._onFrame(delta);
            }
        });
    }

    _detach() {
        this._removeUpdateListener?.();
        this._removeUpdateListener = null;
        if (this._sprite && this._world) {
            this._world.remove(this._sprite);
        }
        this._world = null;
    }

    /** 頭のワールド座標にずれを足した位置へ移す。 */
    _followHead() {
        this._bone.getWorldPosition(this._worldPosition);
        this._sprite.position.copy(this._worldPosition).add(this._offset);
    }

    /** offset 属性を読み直す。表示のたびと接続時にだけ呼ぶ。 */
    _updateOffset() {
        const parsed = parseVector3(this.getAttribute("offset") ?? "");
        const [x, y, z] = this.constructor.defaultOffset;
        this._offset.set(parsed?.x ?? x, parsed?.y ?? y, parsed?.z ?? z);
    }

    /**
     * 不透明度を変える。
     *
     * <three-world> の tween は描画ループから進むので、画面が止まれば
     * 一緒に止まる。setTimeout と違ってフレームと同期する。
     *
     * 緩急は出るときと消えるときで分ける。出るときは easeOut（すっと現れて、
     * ゆっくり落ち着く）、消えるときは easeIn（ゆっくり薄れ始めて、すっと
     * 消える）。どちらも、目に留まりやすい「出ている側」でゆっくり動く
     */
    async _fadeTo(opacity, generation) {
        const from = this._sprite.material.opacity;
        const duration = this._fade();
        if (duration <= 0 || ! this._world) {
            this._sprite.material.opacity = opacity;
            this._applyScale();
            return;
        }
        await this._world.tween({
            from, to: opacity, duration,
            easing: (opacity > from) ? "easeOut" : "easeIn",
            onUpdate: (value) => {
                // 次の表示が始まっていたら、その不透明度を書き換えない
                if (generation === this._generation) {
                    this._sprite.material.opacity = value;
                    this._applyScale();
                }
            }
        });
    }

    /** pop 属性の倍率。属性が無ければ 1（大きさを変えない）。 */
    _popScale() {
        const value = this.getAttribute("pop");
        if (value === null) {
            return 1;
        }
        const scale = Number(value);
        return (value.trim() !== "" && scale > 0) ? Math.min(scale, 1) : DEFAULT_POP_SCALE;
    }

    _size() {
        return Number(this.getAttribute("size")) || this.constructor.defaultSize;
    }

    _boneName() {
        return this.getAttribute("bone") || this.constructor.defaultBone;
    }

    _fade() {
        const value = this.getAttribute("fade");
        return (value === null) ? this.constructor.defaultFade : (Number(value) || 0);
    }
}
