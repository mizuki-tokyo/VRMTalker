import * as THREE from "three";
import VrmHeadSpriteElement from "./vrm-head-sprite-element.js";

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
 *   pop    : 付けると、出るときに膨らみ、消えるときに縮む。値はいちばん
 *            小さいときの倍率（省くと 0.85）。vrm-head-sprite-element.js を参照
 *
 * イベント
 *   load  : アイコンの読み込み完了
 *   error : 読み込み失敗。event.detail.error に例外
 *
 * 頭に付いて回る仕組み（Sprite を使う理由、頭ボーンの子にしない理由）は
 * vrm-head-sprite-element.js を参照。
 */

/** アイコン一覧の既定の場所。 */
export const EMOTES_URL = "./emotes/emotes.json";


export default class VrmEmoteElement extends VrmHeadSpriteElement {

    static defaultOffset = [0.18, 0.28, 0];

    // 名前 -> {texture, aspect, name}
    _icons = new Map();

    // アイコンの一覧が揃ったかどうか。モデルとは関わりが無いので別に持つ
    _iconsReady = null;
    _resolveIcons = null;

    constructor() {
        super();
        this._iconsReady = new Promise((resolve) => {
            this._resolveIcons = resolve;
        });
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

        this._sprite.userData.id = id;
        await this._appear(icon.texture, icon.aspect, generation);
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

    async _loadTextures() {
        // 一覧と絵はモデルと関わりが無いので、先に用意する。
        // ここでモデルを待つと、選択肢を知りたいだけの側まで待たされる
        const url = this.getAttribute("src") || EMOTES_URL;
        try {
            await this._loadIcons(url);
        } finally {
            this._resolveIcons();
        }
    }

    _onLoadFailed() {
        // 一覧を待っている側を取り残さない（失敗しても解決させる）
        this._resolveIcons();
    }

    _disposeTextures() {
        for (const icon of this._icons.values()) {
            icon.texture.dispose();
        }
        this._icons = new Map();
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
}

window.customElements.define("vrm-emote", VrmEmoteElement);
