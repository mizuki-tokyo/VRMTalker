import * as THREE from "three";
import "./vrm-avatar-element.js";

/**
 * <vrm-emote> : アバターの頭の上に感情アイコンを出すカスタム要素。
 *
 * <vrm-avatar> の子要素として記述する。それ自体は何も描画しないため、
 * 表示は none にしてある。
 *
 *   <vrm-avatar src="./models/sample.vrm">
 *     <vrm-emote src="./emotes/emotes.json"></vrm-emote>
 *   </vrm-avatar>
 *
 * 一覧の JSON は次の形。id が名札で、name は画面に出す文字。
 *
 *   [ {"id": "heart", "name": "ハート", "file": "./emotes/heart.png"} ]
 *
 * 属性
 *   src    : アイコン一覧の JSON の URL。既定 "./emotes/emotes.json"
 *   size   : アイコンの高さ（メートル）。既定 0.28
 *   offset : 頭のワールド座標からのずれ "x, y, z"。既定 "0.18, 0.28, 0"
 *   bone   : 追従する VRM ヒューマノイドボーン名。既定 "head"
 *   fade   : 出入りにかける秒数。既定 0.15
 *
 * イベント
 *   load  : アイコンの読み込み完了
 *   error : 読み込み失敗。event.detail.error に例外
 *
 *
 * なぜ Sprite なのか
 * ------------------
 * 板（PlaneGeometry）を置くと、親の回転をそのまま受け継ぐ。アバターが横を
 * 向けばアイコンも裏を向き、首をかしげれば傾く。毎フレーム打ち消す処理が要る。
 * Sprite はシェーダ側でビルボード処理されるので、常にカメラを向く。
 * 材質が無照明なのも都合が良く、シーンのライトでアイコンが暗くならない。
 *
 * なぜ頭ボーンの子にしないのか
 * ----------------------------
 * Sprite でも、ボーンの子にすると位置のずれ（offset）が頭と一緒に回る。
 * 真上に出したつもりが、首をかしげた瞬間に横へずれる。
 * ここでは頭の「ワールド座標」だけを毎フレーム借りて、ずれはワールド座標で
 * 足している。頭がどちらを向いてもアイコンは真上に留まる。
 *
 * DOM の入れ子は「どのアバターのものか」を表すだけで、three.js の親子関係
 * とは一致しない。
 */

/** アイコン一覧の既定の場所。 */
export const EMOTES_URL = "./emotes/emotes.json";

const DEFAULT_SIZE = 0.28;
const DEFAULT_OFFSET = [0.18, 0.28, 0];
const DEFAULT_BONE = "head";
const DEFAULT_FADE = 0.15;

// モデルより手前に描く。髪の毛にアイコンがめり込むのを防ぐ
const RENDER_ORDER = 10;

const parseVector3 = (text) => {
    const values = text.split(",").map((value) => Number(value.trim()));
    if (values.length !== 3 || values.some(Number.isNaN)) {
        return undefined;
    }
    return {x: values[0], y: values[1], z: values[2]};
};


export default class VrmEmoteElement extends HTMLElement {

    _avatar = null;
    _world = null;
    _bone = null;
    _sprite = null;
    _removeUpdateListener = null;

    // 名前 -> {texture, aspect}
    _icons = new Map();

    // 表示のたびに増やす。古い show() が新しい表示を消さないようにする
    _generation = 0;

    _ready = null;
    _resolveReady = null;
    _rejectReady = null;

    // アイコンの一覧が揃ったかどうか。モデルとは関わりが無いので別に持つ
    _iconsReady = null;
    _resolveIcons = null;

    // 頭の位置を毎フレーム受け取る入れ物。フレームごとに作らない
    _worldPosition = new THREE.Vector3();

    // offset 属性を解釈したもの。毎フレーム読み直さないよう持っておく
    _offset = new THREE.Vector3(...DEFAULT_OFFSET);

    constructor() {
        super();
        this._ready = new Promise((resolve, reject) => {
            this._resolveReady = resolve;
            this._rejectReady = reject;
        });
        // error イベントだけを使う場合に unhandled rejection にならないようにする
        this._ready.catch(() => {});

        this._iconsReady = new Promise((resolve) => {
            this._resolveIcons = resolve;
        });
    }

    /** 読み込みが完了すると解決する Promise。値はこの要素自身。 */
    get ready() {
        return this._ready;
    }

    /**
     * アイコンの一覧が揃うと解決する Promise。失敗しても解決する。
     *
     * ready はモデルに貼り付けるところまで待つが、こちらは一覧だけ。
     * 「何が選べるか」を知りたいだけの側（ブロックの編集画面）が、モデルの
     * 読み込みに付き合わなくて済むように分けてある
     */
    get iconsReady() {
        return this._iconsReady;
    }

    /**
     * 使えるアイコン。ブロックの選択肢に使う。
     * @returns {Array<{id: string, name: string}>}
     */
    get emoteChoices() {
        return [...this._icons].map(([id, icon]) => ({id, name: icon.name}));
    }

    /** 今出ているアイコンの id。出ていなければ null。 */
    get current() {
        return this._sprite?.visible ? (this._sprite.userData.id ?? null) : null;
    }

    /**
     * アイコンを出す。
     *
     * seconds を指定すると、その秒数だけ出して自動で消える。0 以下なら
     * clear() を呼ぶまで出しっぱなしにする。
     *
     *   await emote.show("heart", 2);
     *
     * 渡すのは定義の id。知らない id でも例外は投げない（警告して何もしない）。
     * アクションの途中で止まらないようにするため。
     *
     * @param {string} id
     * @param {number} [seconds] 出しておく秒数
     * @returns {Promise<void>} 消え終わった時点で解決する
     */
    async show(id, seconds = 0) {
        await this._ready.catch(() => {});

        const icon = this._icons.get(String(id));
        if (! icon) {
            console.warn(`<vrm-emote>: エモート "${id}" がありません。`
                         + `${EMOTES_URL} に定義してください`);
            return;
        }
        if (! this._sprite) {
            return;
        }

        const generation = ++this._generation;
        const isCurrent = () => generation === this._generation;

        const sprite = this._sprite;
        const size = this._size();
        sprite.material.map = icon.texture;
        sprite.material.needsUpdate = true;
        sprite.scale.set(size * icon.aspect, size, 1);
        sprite.userData.id = id;

        // 出る前に頭の位置へ移しておく。前のアイコンの位置から飛んでこない
        this._updateOffset();
        this._followHead();
        sprite.visible = true;

        await this._fadeTo(1, generation);
        if (! isCurrent() || seconds <= 0) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        if (! isCurrent()) {
            return;
        }
        await this._hide(generation);
    }

    /** アイコンを消す。 */
    async clear() {
        await this._hide(++this._generation);
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

    /** アイコンを破棄する。以降この要素は再利用できない。 */
    dispose() {
        this._detach();
        for (const icon of this._icons.values()) {
            icon.texture.dispose();
        }
        this._icons = new Map();
        this._sprite?.material.dispose();
        this._sprite = null;
        this._bone = null;
    }

    async _load() {
        try {
            await window.customElements.whenDefined("vrm-avatar");
            this._avatar = this.closest("vrm-avatar");
            if (! this._avatar) {
                throw new Error("<vrm-emote> は <vrm-avatar> の子要素として配置してください。");
            }

            // 一覧と絵はモデルと関わりが無いので、先に用意する。
            // ここでモデルを待つと、選択肢を知りたいだけの側まで待たされる
            const url = this.getAttribute("src") || EMOTES_URL;
            try {
                await this._loadIcons(url);
            } finally {
                this._resolveIcons();
            }

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
            // 一覧を待っている側を取り残さない（失敗しても解決させる）
            this._resolveIcons();
            this._rejectReady(error);
            this.dispatchEvent(new CustomEvent("error", {detail: {error}}));
            console.warn("<vrm-emote> の読み込みに失敗しました", error);
        }
    }

    /**
     * アイコン一覧を読み込む。
     *
     * 一部が壊れていても例外は投げない。アイコンが無くてもアプリは会話できるため、
     * 警告にとどめて動かし続ける。
     */
    async _loadIcons(url) {
        const response = await fetch(url);
        if (! response.ok) {
            throw new Error(`${url} を読み込めませんでした (${response.status})`);
        }

        const definitions = await response.json();
        if (! Array.isArray(definitions)) {
            throw new Error(`${url} は配列である必要があります`);
        }

        const loader = new THREE.TextureLoader();

        for (const definition of definitions) {
            const id = definition?.id;
            const file = definition?.file;
            if (! id || ! file) {
                console.warn("エモートの定義に id か file がありません", definition);
                continue;
            }
            // 名前が無ければ id で代用する（選べなくなるよりはよい）
            const name = String(definition.name ?? id);
            try {
                const texture = await loader.loadAsync(file);
                // 付けないと色が褪せる（<three-world> の出力が sRGB のため）
                texture.colorSpace = THREE.SRGBColorSpace;

                const image = texture.image;
                const aspect = (image?.height > 0) ? (image.width / image.height) : 1;
                this._icons.set(String(id), {texture, aspect, name});

            } catch (error) {
                console.warn(`エモート "${id}" (${file}) を読み込めませんでした`, error);
            }
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
            console.warn(`<vrm-emote>: ボーン "${this._boneName()}" が見つかりません。`
                         + `エモートは表示されません`);
            return;
        }

        // Sprite はシーンに直接置く。頭のワールド座標だけを毎フレーム借りる
        this._updateOffset();
        this._world.add(this._sprite);
        this._removeUpdateListener = this._world.addUpdateListener(() => {
            if (this._sprite.visible) {
                this._followHead();
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
        const [x, y, z] = DEFAULT_OFFSET;
        this._offset.set(parsed?.x ?? x, parsed?.y ?? y, parsed?.z ?? z);
    }

    /**
     * 不透明度を変える。
     *
     * <three-world> の tween は描画ループから進むので、画面が止まれば
     * 一緒に止まる。setTimeout と違ってフレームと同期する
     */
    async _fadeTo(opacity, generation) {
        const from = this._sprite.material.opacity;
        const duration = this._fade();
        if (duration <= 0 || ! this._world) {
            this._sprite.material.opacity = opacity;
            return;
        }
        await this._world.tween({
            from, to: opacity, duration,
            onUpdate: (value) => {
                // 次の表示が始まっていたら、その不透明度を書き換えない
                if (generation === this._generation) {
                    this._sprite.material.opacity = value;
                }
            }
        });
    }

    async _hide(generation) {
        if (! this._sprite?.visible) {
            return;
        }
        await this._fadeTo(0, generation);
        if (generation === this._generation) {
            this._sprite.visible = false;
        }
    }

    _size() {
        return Number(this.getAttribute("size")) || DEFAULT_SIZE;
    }

    _boneName() {
        return this.getAttribute("bone") || DEFAULT_BONE;
    }

    _fade() {
        const value = this.getAttribute("fade");
        return (value === null) ? DEFAULT_FADE : (Number(value) || 0);
    }

}

window.customElements.define("vrm-emote", VrmEmoteElement);
