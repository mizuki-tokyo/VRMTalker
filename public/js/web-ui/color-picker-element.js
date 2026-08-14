/**
 * <color-picker> : 色とアルファ値を選ぶカスタム要素。
 *
 * 依存ライブラリなし。他のプロジェクトへはこのファイルを置くだけで持ち込める。
 *
 * 携帯端末での操作を優先し、2 次元の色面ではなく 1 次元のレールを 4 本並べる。
 * どのレールも「どこでもタップで直接指定」「掴んでスワイプ」の両方で操作できる。
 *
 *   <color-picker label="背景色" value="rgba(75, 107, 251, 0.92)"></color-picker>
 *
 * 属性 / プロパティ
 *   value  色。CSS の色表記で受け取り、常に "rgba(r, g, b, a)" で返す
 *   label  見出し
 *   open   付いていればレールを開いた状態
 *
 * プロパティ（読み取り）
 *   rgb    "rgb(r, g, b)"（アルファを除いた色）
 *   alpha  0-1 の数値
 *
 * イベント
 *   input   操作中に連続で発火
 *   change  操作を終えたときに発火
 *
 * CSS カスタムプロパティ
 *   --ink / --surface / --radius / --shadow / --rail-height
 */

const DEFAULT_COLOR = {h: 220, s: 96, l: 64, a: 1};

//------------------------------------------------------------------
// 色の変換
//------------------------------------------------------------------

/** CSS の色表記を {r,g,b,a} にする。解釈できなければ null。 */
const parseCssColor = (value) => {
    if (! value) {
        return null;
    }
    // 解釈はブラウザに任せる。使えない値なら style.color は空のままになる
    const probe = document.createElement("span");
    probe.style.color = value;
    if (! probe.style.color) {
        return null;
    }
    const numbers = probe.style.color.match(/[\d.]+/g);
    if (! numbers || numbers.length < 3) {
        return null;
    }
    return {
        r: Number(numbers[0]),
        g: Number(numbers[1]),
        b: Number(numbers[2]),
        a: numbers.length > 3 ? Number(numbers[3]) : 1
    };
};

const rgbToHsl = ({r, g, b}) => {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;

    if (max === min) {
        return {h: 0, s: 0, l: lightness * 100};
    }
    const delta = max - min;
    const saturation = lightness > 0.5
          ? delta / (2 - max - min)
          : delta / (max + min);

    let hue;
    if (max === r) {
        hue = (g - b) / delta + (g < b ? 6 : 0);
    } else if (max === g) {
        hue = (b - r) / delta + 2;
    } else {
        hue = (r - g) / delta + 4;
    }
    return {h: hue * 60, s: saturation * 100, l: lightness * 100};
};

const hslToRgb = ({h, s, l}) => {
    const saturation = s / 100;
    const lightness = l / 100;
    const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = lightness - c / 2;

    const [r, g, b] =
          h < 60  ? [c, x, 0] :
          h < 120 ? [x, c, 0] :
          h < 180 ? [0, c, x] :
          h < 240 ? [0, x, c] :
          h < 300 ? [x, 0, c] : [c, 0, x];

    return {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255)
    };
};

//------------------------------------------------------------------

const RAILS = [
    {key: "h", label: "色あい",   max: 360},
    {key: "s", label: "あざやかさ", max: 100},
    {key: "l", label: "明るさ",   max: 100},
    {key: "a", label: "透明度",   max: 1}
];

const STYLE_SHEET = new CSSStyleSheet();
STYLE_SHEET.replaceSync(`
  :host {
      --ink:     var(--pop-ink, #23244a);
      --surface: var(--pop-surface, #ffffff);
      --radius:  12px;
      --shadow:  var(--pop-shadow, 0 4px 0 rgba(35, 36, 74, 0.18));
      --rail-height: 14px;

      display: block;
      color: var(--ink);
      font-size: inherit;
  }

  /* 折りたたみ時の 1 行。タップで開く */
  .summary {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      margin: 0;
      padding: 0;
      border: none;
      background: none;
      color: inherit;
      font: inherit;
      font-weight: 700;
      text-align: left;
      cursor: pointer;
  }
  .summary:focus-visible {
      outline: 3px solid var(--pop-yellow, #ffd93d);
      outline-offset: 2px;
      border-radius: 8px;
  }

  .swatch {
      flex: none;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      box-shadow: var(--shadow);
      /* 透明部分が分かるよう市松模様を敷く */
      background-image: var(--swatch-color), var(--checker);
      background-size: auto, 10px 10px;
      background-position: 0 0, 0 0, 5px 5px;
  }
  .caret {
      flex: none;
      margin-left: auto;
      transition: transform 0.15s ease;
  }
  :host([open]) .caret {
      transform: rotate(180deg);
  }

  .rails {
      display: none;
      margin-top: 12px;
  }
  :host([open]) .rails {
      display: block;
  }

  .rail-label {
      margin: 0 0 4px;
      font-size: 0.82em;
      font-weight: 700;
      opacity: 0.65;
  }
  .rail {
      position: relative;
      height: var(--rail-height);
      margin-bottom: 12px;
      border-radius: 999px;
      /* ドラッグ中に画面がスクロールしたり文字が選択されたりしないようにする */
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      cursor: pointer;
  }
  .rail:last-child {
      margin-bottom: 0;
  }
  .rail:focus-visible {
      outline: 3px solid var(--pop-yellow, #ffd93d);
      outline-offset: 3px;
  }
  .thumb {
      position: absolute;
      top: 50%;
      width: calc(var(--rail-height) + 8px);
      height: calc(var(--rail-height) + 8px);
      border-radius: 50%;
      background: var(--surface);
      box-shadow: var(--shadow);
      transform: translate(-50%, -50%);
      pointer-events: none;
  }
`);

export default class ColorPickerElement extends HTMLElement {

    static observedAttributes = ["value", "label", "open"];

    _hsla = {...DEFAULT_COLOR};
    _rails = {};        // key -> {rail, thumb}
    _swatch = null;
    _labelElement = null;
    _initialized = false;

    constructor() {
        super();

        const shadowRoot = this.attachShadow({mode: "open"});
        shadowRoot.adoptedStyleSheets = [STYLE_SHEET];
        shadowRoot.innerHTML = `
<button class="summary" type="button" aria-expanded="false">
  <span class="swatch" aria-hidden="true"></span>
  <span class="label"></span>
  <svg class="caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>
</button>
<div class="rails">
${RAILS.map(({key, label, max}) => `
  <p class="rail-label">${label}</p>
  <div class="rail" data-key="${key}" tabindex="0" role="slider"
       aria-label="${label}" aria-valuemin="0" aria-valuemax="${max}">
    <span class="thumb"></span>
  </div>`).join("")}
</div>`;

        this._swatch = shadowRoot.querySelector(".swatch");
        this._labelElement = shadowRoot.querySelector(".label");
        this._summary = shadowRoot.querySelector(".summary");

        // 市松模様（透明部分の下敷き）
        const checker = "repeating-conic-gradient(#d5d7e5 0% 25%, #ffffff 0% 50%)";
        this.style.setProperty("--checker", checker);

        for (const rail of shadowRoot.querySelectorAll(".rail")) {
            this._rails[rail.dataset.key] = {
                rail,
                thumb: rail.querySelector(".thumb")
            };
        }
    }

    //-------------------------------------------------- 公開インタフェース

    get value() {
        const {r, g, b} = hslToRgb(this._hsla);
        return `rgba(${r}, ${g}, ${b}, ${Number(this._hsla.a.toFixed(3))})`;
    }

    set value(color) {
        const rgba = parseCssColor(color);
        if (! rgba) {
            return;
        }
        this._hsla = {...rgbToHsl(rgba), a: rgba.a};
        this._render();
    }

    /** アルファを除いた色。"rgb(r, g, b)" */
    get rgb() {
        const {r, g, b} = hslToRgb(this._hsla);
        return `rgb(${r}, ${g}, ${b})`;
    }

    /** 0-1 のアルファ値 */
    get alpha() {
        return this._hsla.a;
    }

    get open() {
        return this.hasAttribute("open");
    }

    set open(value) {
        this.toggleAttribute("open", Boolean(value));
    }

    //--------------------------------------------------

    connectedCallback() {
        if (! this._initialized) {
            this._initialized = true;
            const initial = this.getAttribute("value");
            if (initial) {
                this.value = initial;
            }
        }
        this._summary.addEventListener("click", this._onSummaryClick);

        for (const {rail} of Object.values(this._rails)) {
            rail.addEventListener("pointerdown", this._onPointerDown);
            rail.addEventListener("pointermove", this._onPointerMove);
            rail.addEventListener("pointerup", this._onPointerUp);
            rail.addEventListener("pointercancel", this._onPointerUp);
            rail.addEventListener("keydown", this._onKeyDown);
        }
        this._render();
    }

    disconnectedCallback() {
        this._summary.removeEventListener("click", this._onSummaryClick);
        for (const {rail} of Object.values(this._rails)) {
            rail.removeEventListener("pointerdown", this._onPointerDown);
            rail.removeEventListener("pointermove", this._onPointerMove);
            rail.removeEventListener("pointerup", this._onPointerUp);
            rail.removeEventListener("pointercancel", this._onPointerUp);
            rail.removeEventListener("keydown", this._onKeyDown);
        }
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue) {
            return;
        }
        if (name === "value") {
            this.value = newValue;
        } else if (name === "label" || name === "open") {
            this._render();
        }
    }

    _onSummaryClick = () => {
        this.open = ! this.open;
    };

    _onPointerDown = (event) => {
        // pointerdown で preventDefault() すると click とフォーカスまで止まってしまう。
        // スクロールと文字選択は CSS（touch-action / user-select）で抑えてある
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        this._updateFromPointer(event);
    };

    _onPointerMove = (event) => {
        if (! event.currentTarget.hasPointerCapture(event.pointerId)) {
            return;
        }
        this._updateFromPointer(event);
    };

    _onPointerUp = (event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        this.dispatchEvent(new Event("change", {bubbles: true}));
    };

    _onKeyDown = (event) => {
        const step = {ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1}[event.key];
        if (step === undefined) {
            return;
        }
        event.preventDefault();

        const key = event.currentTarget.dataset.key;
        const {max} = RAILS.find((r) => r.key === key);
        // 透明度は 0-1 なので刻みを細かくする
        const amount = step * (max <= 1 ? 0.02 : 1) * (event.shiftKey ? 10 : 1);

        this._setChannel(key, this._hsla[key] + amount);
        this.dispatchEvent(new Event("change", {bubbles: true}));
    };

    _updateFromPointer(event) {
        const rail = event.currentTarget;
        const bounds = rail.getBoundingClientRect();
        const ratio = (event.clientX - bounds.left) / bounds.width;

        const key = rail.dataset.key;
        const {max} = RAILS.find((r) => r.key === key);
        this._setChannel(key, ratio * max);
    }

    _setChannel(key, rawValue) {
        const {max} = RAILS.find((r) => r.key === key);
        this._hsla[key] = Math.min(Math.max(rawValue, 0), max);
        this._render();
        this.dispatchEvent(new Event("input", {bubbles: true}));
    }

    _render() {
        const {h, s, l, a} = this._hsla;

        this._labelElement.textContent = this.getAttribute("label") || "";
        this._summary.setAttribute("aria-expanded", String(this.open));
        this._swatch.style.setProperty(
            "--swatch-color", `linear-gradient(${this.value}, ${this.value})`);

        const solid = `hsl(${h} ${s}% ${l}%)`;
        const backgrounds = {
            h: "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%,"
               + " #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)",
            s: `linear-gradient(to right, hsl(${h} 0% ${l}%), hsl(${h} 100% ${l}%))`,
            l: `linear-gradient(to right, #000, hsl(${h} ${s}% 50%), #fff)`,
            // 透明部分が見えるよう市松模様の上に重ねる
            a: `linear-gradient(to right, transparent, ${solid}),`
               + ` var(--checker)`
        };

        for (const {key, max} of RAILS) {
            const {rail, thumb} = this._rails[key];
            rail.style.background = backgrounds[key];
            if (key === "a") {
                rail.style.backgroundSize = "auto, 10px 10px";
            }
            thumb.style.left = `${(this._hsla[key] / max) * 100}%`;
            rail.setAttribute("aria-valuenow", String(Math.round(this._hsla[key] * 100) / 100));
        }
    }
}

window.customElements.define("color-picker", ColorPickerElement);
