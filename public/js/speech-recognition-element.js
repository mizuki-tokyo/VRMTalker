
import SpeechRecognizer from "./speech-recognizer.js";

/**
 * <speech-recognition> : 音声認識を開始するマイクボタン。
 *
 * ボタンの周囲のリングは入力レベル（音量）を表す。
 *
 * 大きさは CSS で決める。SVG の viewBox を固定してあるため、
 * どの大きさでもリングの太さと比率は変わらない。
 *
 *   speech-recognition { --size: 64px; }
 *   speech-recognition { --size: clamp(48px, 8vw, 68px); }
 *
 * CSS カスタムプロパティ
 *   --size        ボタンの直径（既定 40px）
 *   --background  ボタンの背景色
 *   --foreground  マイクアイコンの色
 *   --level-color 入力レベルのリングの色
 *
 * 属性（CSS を書かずに済ませたい場合の入口。指定があれば --size 等より優先する）
 *   size / background / foreground
 *
 * Microphone svg is below.
 * Font Awesome Free 6.2.1 by @fontawesome
 *    - https://fontawesome.com License
 */

// リング用 SVG の座標系。ピクセルではなくこの単位で描くので、
// 表示サイズが変わってもリングの計算式は変わらない
const VIEW_BOX_SIZE = 100;
const RING_STROKE_WIDTH = 10;
const RING_RADIUS = VIEW_BOX_SIZE / 2 - RING_STROKE_WIDTH / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const STYLE_SHEET = new CSSStyleSheet();
STYLE_SHEET.replaceSync(`
  :host {
      --size:        var(--ui-button-size, 40px);
      --background:  var(--pop-blue, royalblue);
      --foreground:  #ffffff;
      --level-color: var(--pop-yellow, orange);
      --shadow:      var(--pop-shadow, 0 4px 0 rgba(35, 36, 74, 0.18));

      display: inline-block;
      line-height: 0;
      width: var(--size);
      height: var(--size);
  }
  :host([hidden]) {
      display: none;
  }

  .anchor {
      position: relative;
      display: block;
      width: 100%;
      height: 100%;
  }

  .button {
      position: absolute;
      inset: 0;
      margin: 0;
      padding: 0;
      border: none;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: var(--background);
      box-shadow: var(--shadow);
      display: flex;
      justify-content: center;
      align-items: center;
      cursor: pointer;
      transition: transform 0.1s ease, box-shadow 0.1s ease;
  }
  .button:hover {
      filter: brightness(1.08);
  }
  .button:active {
      transform: translateY(2px);
      box-shadow: 0 2px 0 rgba(35, 36, 74, 0.18);
  }
  .button:focus-visible {
      outline: 3px solid var(--level-color);
      outline-offset: 2px;
  }

  .icon {
      width: 60%;
      height: 60%;
      fill: var(--foreground);
  }

  /* 入力レベルのリング。ボタンの上に重ねる */
  .level {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
  }
  .level circle {
      fill: transparent;
      stroke: var(--level-color);
      stroke-width: ${RING_STROKE_WIDTH};
      /* 12 時の位置から時計回りに伸ばす */
      transform: rotate(-90deg);
      transform-origin: center;
  }
`);

const HTML = `
<span class="anchor">
  <button class="button" type="button">
    <svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512">
      <path d="M192 0C139 0 96 43 96 96V256c0 53 43 96 96 96s96-43 96-96V96c0-53-43-96-96-96zM64 216c0-13.3-10.7-24-24-24s-24 10.7-24 24v40c0 89.1 66.2 162.7 152 174.4V464H120c-13.3 0-24 10.7-24 24s10.7 24 24 24h72 72c13.3 0 24-10.7 24-24s-10.7-24-24-24H216V430.4c85.8-11.7 152-85.3 152-174.4V216c0-13.3-10.7-24-24-24s-24 10.7-24 24v40c0 70.7-57.3 128-128 128s-128-57.3-128-128V216z"/>
    </svg>
  </button>
  <svg class="level" viewBox="0 0 ${VIEW_BOX_SIZE} ${VIEW_BOX_SIZE}">
    <circle cx="${VIEW_BOX_SIZE / 2}" cy="${VIEW_BOX_SIZE / 2}" r="${RING_RADIUS}"></circle>
  </svg>
</span>`;

export default class SpeechRecognitionElement extends HTMLElement {

    // callback
    onnomatch = (event) => {};
    onerror = (event) => {};
    onresult = (text) => {};

    _buttonElement = null;
    _circleElement = null;

    _recognizer = new SpeechRecognizer();

    constructor() {
        super();

        const shadowRoot = this.attachShadow({mode: "open"});
        shadowRoot.adoptedStyleSheets = [STYLE_SHEET];
        shadowRoot.innerHTML = HTML;

        this._buttonElement = shadowRoot.querySelector(".button");
        this._circleElement = shadowRoot.querySelector(".level circle");

        // 消灯状態から始める
        this._circleElement.style.strokeDasharray = RING_CIRCUMFERENCE;
        this._circleElement.style.strokeDashoffset = RING_CIRCUMFERENCE;
    }

    connectedCallback() {
        this._applyAttributes();
        this._buttonElement.addEventListener("click", this._onClick);
    }

    disconnectedCallback() {
        this._buttonElement.removeEventListener("click", this._onClick);
    }

    /**
     * 属性が指定されていれば CSS カスタムプロパティへ移す。
     * 大きさや色は CSS で書くのが基本だが、属性でも指定できるようにしておく
     */
    _applyAttributes() {
        const size = this.getAttribute("size");
        if (size) {
            // 数値だけなら px とみなす
            this.style.setProperty("--size", /^\d+(\.\d+)?$/.test(size) ? `${size}px` : size);
        }
        const background = this.getAttribute("background");
        if (background) {
            this.style.setProperty("--background", background);
        }
        const foreground = this.getAttribute("foreground");
        if (foreground) {
            this.style.setProperty("--foreground", foreground);
        }
    }

    _onClick = () => {
        this._recognizer.onvolumechange = (value) => {
            this.setInputLevel(value);
        };
        this._recognizer.onerror = (e) => {
            this.setInputLevel(0);
            setTimeout(() => {
                this.onerror(e);
            }, 0);
        };
        this._recognizer.onnomatch = (e) => {
            this.setInputLevel(0);
            setTimeout(() => {
                this.onnomatch(e);
            }, 0);
        };
        this._recognizer.onresult = (text, isFinal) => {
            if (isFinal) {
                this.setInputLevel(0);
                setTimeout(() => {
                    this.onresult(text);
                }, 0);
            }
        };
        this._recognizer.start();
    };

    /**
     * 入力レベルのリングを更新する。
     * @param {number} value 0-100
     */
    setInputLevel(value) {
        if (value < 0) {
            value = 0;
        } else if (value > 100) {
            value = 100;
        }

        this._circleElement.style.strokeLinecap = (value === 0) ? "butt" : "round";
        this._circleElement.style.strokeDashoffset =
            (100 - value) * RING_CIRCUMFERENCE / 100;
    }
}

window.customElements.define("speech-recognition", SpeechRecognitionElement);
