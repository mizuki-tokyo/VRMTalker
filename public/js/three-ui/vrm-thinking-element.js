import * as THREE from "three";
import VrmHeadSpriteElement from "./vrm-head-sprite-element.js";

/**
 * <vrm-thinking> : 返事を考えている間、アバターの頭の上に出す吹き出し。
 *
 * 中の点が「.」→「..」→「...」→「.」と時間で変わる。
 * <vrm-emote> と同じく <vrm-avatar> の子要素として記述する。
 *
 *   <vrm-avatar src="./models/sample.vrm">
 *     <vrm-thinking src="./icons/thinking-bubble.svg"></vrm-thinking>
 *   </vrm-avatar>
 *
 *   thinking.show();   // 出す
 *   thinking.hide();   // 消す
 *
 * 属性
 *   src      : 吹き出しの SVG の URL。既定 "./icons/thinking-bubble.svg"
 *   interval : 点を 1 つ増やす間隔（秒）。既定 0.4
 *   fade     : 出入りにかける秒数。既定 0.3（エモートより長め。返事を待つ間の
 *              表示なので、ふっと現れて、ふっと消えるほうが自然に見える）
 *   size / offset / bone / pop : <vrm-emote> と同じ。offset の既定は
 *              "-0.18, 0.28, 0"（エモートと左右反対の側。重ならないように）
 *
 * 点の動かし方
 * ------------
 * SVG を three.js の絵（テクスチャ）にすると、止まった 1 枚の絵になり、
 * SVG の中のアニメーションは動かない。そこで読み込むときに、点が 1 つ・2 つ・
 * 3 つの絵を作っておき、出している間はそれを順に差し替える。
 * 点は SVG の class="dot" の要素で、左から順に見せていく。無ければ、
 * そのままの絵を 1 枚だけ出す。
 */

/** 吹き出しの SVG の既定の場所。 */
export const THINKING_BUBBLE_URL = "./icons/thinking-bubble.svg";

const DEFAULT_INTERVAL = 0.4;

// SVG を絵にするときの高さ（ピクセル）。近づいても粗く見えない大きさ
const RASTER_HEIGHT = 512;


/** 画像を読み込み終えるまで待つ。 */
const loadImage = (url) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`${url} を絵にできませんでした`));
    image.src = url;
});


export default class VrmThinkingElement extends VrmHeadSpriteElement {

    static defaultOffset = [-0.18, 0.28, 0];
    static defaultFade = 0.3;

    // 点が 1 つ・2 つ・3 つの絵。[{texture, aspect}]
    _frames = [];

    // 出すよう頼まれているか（読み込みを待つ間に消すよう頼まれたら出さない）
    _showing = false;

    // 出してからの秒数と、出している絵の番号
    _elapsed = 0;
    _frameIndex = 0;

    /** 出すよう頼まれているか。 */
    get showing() {
        return this._showing;
    }

    /** 吹き出しを出す。もう出ていれば何もしない。 */
    async show() {
        if (this._showing) {
            return;
        }
        this._showing = true;
        await this._ready.catch(() => {});
        if (! this._showing || ! this._sprite || this._frames.length === 0) {
            return;
        }
        const generation = ++this._generation;
        // いつも「.」から始める
        this._elapsed = 0;
        this._frameIndex = 0;
        const frame = this._frames[0];
        await this._appear(frame.texture, frame.aspect, generation);
    }

    /** 吹き出しを消す。 */
    async hide() {
        this._showing = false;
        await this._hide(++this._generation);
    }

    _onFrame(delta) {
        if (this._frames.length < 2) {
            return;
        }
        this._elapsed += delta;
        const index = Math.floor(this._elapsed / this._interval()) % this._frames.length;
        if (index !== this._frameIndex) {
            this._frameIndex = index;
            const frame = this._frames[index];
            this._setTexture(frame.texture, frame.aspect);
        }
    }

    async _loadTextures() {
        const url = this.getAttribute("src") || THINKING_BUBBLE_URL;
        const response = await fetch(url);
        if (! response.ok) {
            throw new Error(`${url} を読み込めませんでした (${response.status})`);
        }
        const svg = new DOMParser().parseFromString(await response.text(), "image/svg+xml");
        if (svg.documentElement.localName !== "svg") {
            throw new Error(`${url} は SVG ではありません`);
        }

        const dots = [...svg.querySelectorAll(".dot")];
        if (dots.length === 0) {
            console.warn(`<vrm-thinking>: ${url} に class="dot" の点がありません。`
                         + `点を動かさずに出します`);
            this._frames = [await this._rasterize(svg)];
            return;
        }
        // 点を左から 1 つずつ見せていく
        for (let count = 1; count <= dots.length; count++) {
            dots.forEach((dot, i) => {
                dot.setAttribute("visibility", (i < count) ? "visible" : "hidden");
            });
            this._frames.push(await this._rasterize(svg));
        }
    }

    _disposeTextures() {
        for (const frame of this._frames) {
            frame.texture.dispose();
        }
        this._frames = [];
    }

    /**
     * SVG を絵（テクスチャ）にする。
     *
     * 幅と高さを書き込んでから描く。小さいまま描いて引き伸ばすと、
     * ブラウザによってはぼやける
     */
    async _rasterize(svg) {
        const root = svg.documentElement;
        const [, , viewWidth, viewHeight] = (root.getAttribute("viewBox") ?? "0 0 1 1")
              .split(/[\s,]+/).map(Number);
        const aspect = (viewHeight > 0) ? (viewWidth / viewHeight) : 1;
        const width = Math.round(RASTER_HEIGHT * aspect);
        root.setAttribute("width", String(width));
        root.setAttribute("height", String(RASTER_HEIGHT));

        const blob = new Blob([new XMLSerializer().serializeToString(svg)],
                              {type: "image/svg+xml"});
        const url = URL.createObjectURL(blob);
        try {
            const image = await loadImage(url);
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = RASTER_HEIGHT;
            canvas.getContext("2d").drawImage(image, 0, 0, width, RASTER_HEIGHT);

            const texture = new THREE.CanvasTexture(canvas);
            // 付けないと色が褪せる（<three-world> の出力が sRGB のため）
            texture.colorSpace = THREE.SRGBColorSpace;
            return {texture, aspect};
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    _interval() {
        return Number(this.getAttribute("interval")) || DEFAULT_INTERVAL;
    }
}

window.customElements.define("vrm-thinking", VrmThinkingElement);
