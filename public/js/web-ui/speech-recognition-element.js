
/**
 * <speech-recognition> : 音声認識を開始するマイクボタン。
 *
 * ボタンの周囲のリングは入力レベル（音量）を表す。
 *
 * 認識そのものは行わない。使う前に recognizer を注入すること（app.js が行う）。
 * 注入されるまでボタンは押せない。
 *
 *   element.recognizer = new WebSpeechRecognizer();
 *
 * 注入するオブジェクトは start() / stop() を持ち、volumechange / result /
 * error / nomatch のイベントを発火すること（js/speech-recognizer.js 参照）。
 * この要素は認識方式を知らないので、実装を増やしてもここは変わらない。
 *
 * 認識結果は recognizer が直接返す。この要素は中継しない。
 *
 *   recognizer.onresult = (event) => console.log(event.detail.text);
 *
 * 購読には addEventListener を使うので、呼び出し側が onresult などに代入しても
 * 互いを潰さない。
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
  /* recognizer が注入されるまでの状態。:hover より後に書いて打ち消す */
  .button:disabled {
      cursor: default;
      opacity: 0.4;
      filter: grayscale(1);
      box-shadow: none;
      transform: none;
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

    _buttonElement = null;
    _disabled = false;
    _circleElement = null;

    // 音声認識の実装。使う前に外から注入する
    _recognizer = null;

    // 注入した recognizer に登録したリスナー。差し替え時に外すため保持する
    _listeners = null;

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

        // recognizer が注入されるまでは押せない
        this._updateAvailability();
    }

    connectedCallback() {
        this._applyAttributes();
        this._buttonElement.addEventListener("click", this._onClick);

        // DOM 内を移動した場合、外した購読をここで張り直す
        if (this._recognizer && ! this._listeners) {
            this._bindRecognizer(this._recognizer);
        }
    }

    disconnectedCallback() {
        this._buttonElement.removeEventListener("click", this._onClick);
        this._unbindRecognizer();
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

    /**
     * 音声認識の実装を設定する。null を渡すと解除する。
     * @param {EventTarget} recognizer start() / stop() を持ち、volumechange などの
     *                                 イベントを発火するオブジェクト
     */
    set recognizer(recognizer) {
        this._unbindRecognizer();
        this._recognizer = recognizer || null;
        if (this._recognizer) {
            this._bindRecognizer(this._recognizer);
        }
        this._updateAvailability();
    }

    get recognizer() {
        return this._recognizer;
    }

    /**
     * 注入された実装の通知を、この要素の表示につなぐ。
     *
     * 代入ではなく addEventListener で購読する。代入にすると、呼び出し側が
     * 設定した onvolumechange などを上書きしてしまう
     */
    _bindRecognizer(recognizer) {
        const reset = () => this.setInputLevel(0);
        this._listeners = {
            volumechange: (event) => this.setInputLevel(event.detail.level),
            result: reset,
            error: reset,
            nomatch: reset
        };
        for (const [type, listener] of Object.entries(this._listeners)) {
            recognizer.addEventListener(type, listener);
        }
    }

    _unbindRecognizer() {
        if (! this._recognizer || ! this._listeners) {
            return;
        }
        for (const [type, listener] of Object.entries(this._listeners)) {
            this._recognizer.removeEventListener(type, listener);
        }
        this._listeners = null;
    }

    /**
     * 押せないようにする。
     *
     * ブロックの編集中など、会話を受け付けたくないときに使う。認識中なら止める。
     * 押せるかどうかは recognizer の有無とこの指定の両方で決まる
     */
    set disabled(value) {
        this._disabled = Boolean(value);
        if (this._disabled) {
            this._recognizer?.stop();
        }
        this._updateAvailability();
    }

    get disabled() {
        return Boolean(this._disabled);
    }

    /** recognizer が無いうちは押しても何も起きないので、押せないようにする。 */
    _updateAvailability() {
        if (this._buttonElement) {
            this._buttonElement.disabled = ! this._recognizer || this._disabled;
        }
    }

    _onClick = () => {
        // disabled のボタンはクリックされないが、念のため
        if (! this._recognizer) {
            return;
        }
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
