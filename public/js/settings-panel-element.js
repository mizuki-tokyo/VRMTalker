/**
 * <settings-panel> : 設定項目や操作ボタンを収めるモードレスウインドウ。
 *
 * ボタン（三本線アイコン）を起点に、左上へ向かって開く。モードレスなので
 * 開いたままでも背後の 3D モデルを操作できる（背景を覆わない）。
 *
 * 中身は light DOM のまま slot で受け取るので、利用側が自由に組み立てられる。
 *
 *   <settings-panel label="設定">
 *     <label>話者 <select id="speaker"></select></label>
 *     <button id="clear">会話履歴をクリア</button>
 *   </settings-panel>
 *
 * 属性
 *   open  : 付いていれば開いた状態
 *   label : ボタンとウインドウのアクセシブル名（既定 "設定"）
 *
 * イベント
 *   toggle : 開閉時。event.detail.open に真偽値
 */

const STYLE_SHEET = new CSSStyleSheet();
STYLE_SHEET.replaceSync(`
  :host {
      display: inline-block;
      line-height: 0;

      /* 画面側で --ui-* を定義していない場合の既定値 */
      --size:   var(--ui-button-size, 48px);
      --accent: var(--pop-blue, royalblue);
      --ink:    var(--pop-ink, #23244a);
      --radius: var(--ui-radius, 18px);
      --shadow: var(--pop-shadow, 0 4px 0 rgba(35, 36, 74, 0.18));
  }
  .anchor {
      position: relative;
      display: inline-block;
  }

  /* 三本線アイコンのボタン。<speech-recognition> と見た目を揃える */
  .button {
      margin: 0;
      padding: 0;
      border: none;
      width: var(--size);
      height: var(--size);
      border-radius: 50%;
      background: var(--accent);
      box-shadow: var(--shadow);
      display: flex;
      justify-content: center;
      align-items: center;
      cursor: pointer;
      transition: transform 0.1s ease, box-shadow 0.1s ease;
  }
  .button svg {
      width: 45%;
      height: 45%;
  }
  .button:hover {
      filter: brightness(1.08);
  }
  .button:active {
      transform: translateY(2px);
      box-shadow: 0 2px 0 rgba(35, 36, 74, 0.18);
  }
  .button:focus-visible {
      outline: 3px solid var(--pop-yellow, #ffd93d);
      outline-offset: 2px;
  }

  /*
   * ボタンの右下を起点に、左上へ広がるウインドウ。
   * right/bottom を固定して幅と高さが左と上へ伸びるようにする
   */
  .panel {
      position: absolute;
      right: 0;
      bottom: calc(100% + 10px);
      transform-origin: bottom right;

      box-sizing: border-box;
      /* 狭い画面では画面幅いっぱいまで縮む */
      width: max-content;
      min-width: min(240px, calc(100vw - var(--ui-gap, 16px) * 4));
      max-width: min(340px, calc(100vw - var(--ui-gap, 16px) * 3));
      max-height: 60vh;
      overflow-y: auto;
      padding: 16px 18px;

      background: var(--pop-surface, #fff);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      color: var(--ink);
      font-size: var(--ui-font, 14px);
      line-height: 1.6;
      text-align: left;

      /*
       * 閉じている間は操作不能にする。
       * visibility は 0.15 秒かけて遷移するため、その間もクリックを奪わないよう
       * pointer-events を即座に切っておく
       */
      visibility: hidden;
      pointer-events: none;
      opacity: 0;
      transform: scale(0.85);
      transition: opacity 0.15s ease, transform 0.15s ease, visibility 0.15s;
  }
  :host([open]) .panel {
      visibility: visible;
      pointer-events: auto;
      opacity: 1;
      transform: scale(1);
  }

  .title {
      margin: 0 0 12px;
      padding-bottom: 8px;
      border-bottom: 3px solid var(--pop-yellow, #ffd93d);
      font-size: 0.9em;
      font-weight: 800;
      color: var(--ink);
  }

  /* slot で受け取った中身の最低限の体裁 */
  ::slotted(*) {
      display: block;
      margin: 0 0 14px;
  }
  ::slotted(*:last-child) {
      margin-bottom: 0;
  }
`);

const HAMBURGER_ICON = `
<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
  <g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round">
    <line x1="3" y1="5"  x2="17" y2="5"/>
    <line x1="3" y1="10" x2="17" y2="10"/>
    <line x1="3" y1="15" x2="17" y2="15"/>
  </g>
</svg>`;

export default class SettingsPanelElement extends HTMLElement {

    static observedAttributes = ["open", "label"];

    _button = null;
    _panel = null;

    constructor() {
        super();

        const shadowRoot = this.attachShadow({mode: "open"});
        shadowRoot.adoptedStyleSheets = [STYLE_SHEET];
        shadowRoot.innerHTML = `
<span class="anchor">
  <div class="panel" role="dialog" aria-modal="false">
    <p class="title"></p>
    <slot></slot>
  </div>
  <button class="button" type="button" aria-haspopup="dialog" aria-expanded="false">
    ${HAMBURGER_ICON}
  </button>
</span>`;

        this._button = shadowRoot.querySelector(".button");
        this._panel = shadowRoot.querySelector(".panel");
    }

    get open() {
        return this.hasAttribute("open");
    }

    set open(value) {
        this.toggleAttribute("open", Boolean(value));
    }

    show() {
        this.open = true;
    }

    hide() {
        this.open = false;
    }

    toggle() {
        this.open = ! this.open;
    }

    connectedCallback() {
        this._button.addEventListener("click", this._onButtonClick);
        // モードレスなので画面外クリックでは閉じない。Escape だけは受け付ける
        this.addEventListener("keydown", this._onKeyDown);

        this._applyLabel();
        this._applyOpenState();
    }

    disconnectedCallback() {
        this._button.removeEventListener("click", this._onButtonClick);
        this.removeEventListener("keydown", this._onKeyDown);
    }

    attributeChangedCallback(name) {
        if (name === "open") {
            this._applyOpenState();
        } else if (name === "label") {
            this._applyLabel();
        }
    }

    _onButtonClick = () => {
        this.toggle();
    };

    _onKeyDown = (event) => {
        if (event.key === "Escape" && this.open) {
            this.hide();
            this._button.focus();
        }
    };

    _applyLabel() {
        const label = this.getAttribute("label") || "設定";
        this._button.setAttribute("aria-label", label);
        this._panel.setAttribute("aria-label", label);
        this._panel.querySelector(".title").textContent = label;
    }

    _applyOpenState() {
        const open = this.open;
        this._button.setAttribute("aria-expanded", String(open));
        this.dispatchEvent(new CustomEvent("toggle", {detail: {open}}));
    }
}

window.customElements.define("settings-panel", SettingsPanelElement);
