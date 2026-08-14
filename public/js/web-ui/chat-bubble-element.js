
const _BUBBLE_CORNER_RADIUS = 72; // 四隅の R の 半径 72
const _BUBBLE_TAIL_WIDTH = 16; // 尾尻の幅 16

const _BUBBLE_MIN_WIDTH = _BUBBLE_CORNER_RADIUS * 2 + _BUBBLE_TAIL_WIDTH;
const _BUBBLE_MIN_HEIGHT = _BUBBLE_CORNER_RADIUS * 2;

const _createRightBubblePath = (width, height) => {
    const pathData = [
        `M 72 0`,                                      // 左上角の開始点に移動
        `H ${width-(72+16)}`,                          // 上辺の直線
        `c 20.991 0 39.896 9.002 53.061 23.353`,       // 尻尾
        `C ${width-21.718} 23.375 ${width-2.828} 19.837 ${width} 0`,// 尻尾の続き
        `c -0.487 22.396 -9.937 37.502 -20.325 47.384`,// 尻尾の終端
        `A 72 72 0 0 1 ${width-16} 72`,                // 右上角の円弧
        `V ${height-72}`,                              // 右辺の直線
        `A 72 72 0 0 1 ${width-72-16} ${height}`,      // 右下角の円弧
        `H 72`,                                        // 下辺の直線
        `A 72 72 0 0 1 0 ${height-72}`,                // 左下角の円弧
        `V 72`,                                        // 左辺の直線
        `A 72 72 0 0 1 72 0`,                          // 左上角の円弧
        `Z`                                            // パスを閉じる
    ];
    return pathData.join(' ');
};

const _createLeftBubblePath = (width, height) => {
    const pathData = [
        `M ${width-72} 0`,                             // 右上角の開始点に移動
        `H ${72+16}`,                                  // 上辺の直線（尻尾の付け根まで）
        `c -20.991 0 -39.896 9.002 -53.061 23.353`,    // 尻尾
        `C 21.718 23.375 2.828 19.837 0 0`,            // 尻尾の続き
        `c 0.487 22.396 9.937 37.502 20.325 47.384`,   // 尻尾の終端
        `A 72 72 0 0 0 16 72`,                         // 左上角の円弧
        `V ${height-72}`,                              // 左辺の直線
        `A 72 72 0 0 0 ${72+16} ${height}`,            // 左下角の円弧
        `H ${width-72}`,                               // 下辺の直線
        `A 72 72 0 0 0 ${width} ${height-72}`,         // 右下角の円弧
        `V 72`,                                        // 右辺の直線
        `A 72 72 0 0 0 ${width-72} 0`,                 // 右上角の円弧
        `Z`                                            // パスを閉じる
    ];
    return pathData.join(' ');
};


const _ChatBubbleElementStyle_ = new CSSStyleSheet()
_ChatBubbleElementStyle_.replaceSync(`
:host {
   --font-family: inherit;
   --font-color: dimgray;
   --font-size: 14px;
   --line-height: 1.4;
   --font-weight: 500;
   --fill: white;
   --fill-opacity: 0.5;

   display: inline-block;
   position: relative;
}
.bubble-container {
   position: relative;
   margin: 0;
   padding: 0;
   border: none;
}
.bubble-svg {
   position: absolute;
   top: 0;
   left: 0;
   right: 0;
   width: 100%;
   height: 100%;
   filter: drop-shadow(0px 2px 4px rgba(0,0,0,0.4));
}
.bubble-svg path {
   fill: var(--fill);
}
.bubble-svg path {
   fill-opacity: var(--fill-opacity);
}
.bubble-text {
   position: absolute;
   display: flex;
   align-items: center;
   color: var(--font-color);
}
`);

class ChatBubbleElement extends HTMLElement {

    static relayout(maxWidth) {
        document.querySelectorAll("chat-bubble").forEach((chatBubble) => {
            chatBubble.maxWidth = maxWidth;
        });
    }

    _max_width = 350;
    //_textColor = "lightgray";
    _bubbleColor = "lightblue";
    _bubbleOpacity = 0.5;

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.shadowRoot.adoptedStyleSheets = [_ChatBubbleElementStyle_];
    }

    // get textColor() {
    //     return this._textColor;
    // }

    // set textColor(value) {
    //     if (this._textColor != value) {
    //         this._textColor = value;
    //         this.shadowRoot.querySelector(".bubble-text").style.color = this._textColor;
    //     }
    // }

    get bubbleColor() {
        return this.shadowRoot.querySelector("path").style.fill;
    }

    set bubbleColor(value) {
        return this.shadowRoot.querySelector("path").style.fill = value;
    }

    get bubbleOpacity() {
        return this.shadowRoot.querySelector("path").style.fillOpacity;
    }

    set bubbleOpacity(value) {
        this.shadowRoot.querySelector("path").style.fillOpacity = value;
    }

    set maxWidth(value) {
        this._max_width = value;

        const type = this.getAttribute('type') || 'left'; // 'left' or 'right'
        this._render(type);
    }

    get maxWidth() {
        return this._max_width;
    }

    connectedCallback() {
        const type = this.getAttribute('type') || 'left'; // 'left' or 'right'
        this._render(type);

        // DOM 内を移動した場合に二重登録しないよう、貼り直す前に外す
        this._resizeObserver?.disconnect();
        this._resizeObserver = new ResizeObserver(entries => {
            // ResizeObserver のハンドラの中でリサイズ処理を行わないこと
            setTimeout(() => {
                // ハンドラを抜けてからリサイズ処理を行う。
                // その間に取り外されていることがあるので、その場合は何もしない
                if (! this.isConnected) {
                    return;
                }
                const type = this.getAttribute('type') || 'left'; // 'left' or 'right'
                this._render(type);
            }, 0);
        });
        this._resizeObserver.observe(this.parentElement);
    }

    disconnectedCallback() {
        // 外した後も監視が残ると、親を失った状態で _render が呼ばれてしまう
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
    }

    _getComputedStyle(name, styles) {
        if (! styles) {
            styles = window.getComputedStyle(this);
        }
        let value = styles.getPropertyValue(`--${name}`)
        if (value === "inherit" || value === "") {
            value = styles.getPropertyValue(name);
        }
        return value;
    }

    _render(type) {
        // 親のサイズを基準に描画するため、取り外し済みなら何もしない
        if (! this.parentElement) {
            return;
        }
        const SCALE = 0.3; // SVG のスケール

        const pad1 = (_BUBBLE_CORNER_RADIUS * 0.5) * SCALE;
        const pad2 = (_BUBBLE_CORNER_RADIUS * 0.5 + _BUBBLE_TAIL_WIDTH) * SCALE;

        const max_width = Math.min(this._max_width, this.parentElement.offsetWidth);

        const styles = window.getComputedStyle(this);
        const cssText = `
            white-space: pre-wrap;
            word-wrap: break-word;
            font-family: ${this._getComputedStyle('font-family', styles)};
            font-size: ${this._getComputedStyle('font-size', styles)};
            line-height: ${this._getComputedStyle('line-height', styles)};
            font-weight: ${this._getComputedStyle('font-weight', styles)};
            margin: 0;
            padding: ${(type === 'right')? 
                 `${pad1}px ${pad2}px ${pad1}px ${pad1}px` :
                 `${pad1}px ${pad1}px ${pad1}px ${pad2}px`} !important;
            border: none;
            max-width: ${max_width - pad1 * 2}px;
        `;
        // テキストのサイズを測定するための仮要素を作成
        const measurer = document.createElement('div');
        measurer.style.cssText = `position:absolute; visibility:hidden; ${cssText}`;
        measurer.textContent = this.textContent;
        //this.shadowRoot.appendChild(measurer); // 外側の要素の影響を受けることがある
        document.body.appendChild(measurer);
        // offsetWidth の小数値は丸められるため、 折り返し表示を防ぐために 1 を足す
        const textWidth = Math.max(_BUBBLE_MIN_WIDTH * SCALE, measurer.offsetWidth + 1);
        const textHeight = Math.max(_BUBBLE_MIN_HEIGHT * SCALE, measurer.offsetHeight);
        //this.shadowRoot.removeChild(measurer);
        document.body.removeChild(measurer);

        // バブルのサイズを計算（最小サイズとパディングを考慮）
        const boundingWidth = textWidth;
        const boundingHeight = textHeight;
        const bubbleWidth = textWidth / SCALE;
        const bubbleHeight = textHeight / SCALE;

        const pathData = type === 'right' 
              ? _createRightBubblePath(bubbleWidth, bubbleHeight)
              : _createLeftBubblePath(bubbleWidth, bubbleHeight);

        this.shadowRoot.innerHTML = `
            <style>
                .bubble-container {
                    width: ${boundingWidth}px;
                    height: ${boundingHeight}px;
                }
                .bubble-text {
                    height: ${textHeight - pad1*2}px;
                    ${cssText}
                }
            </style>
            <div class="bubble-container">
                 <svg class="bubble-svg" width="${bubbleWidth}" height="${bubbleHeight}" viewBox="0 0 ${bubbleWidth} ${bubbleHeight}">
                    <path d="${pathData}"/>
                </svg>
                <div class="bubble-text"><slot></slot></div>
            </div>
        `;
    }
}

// カスタム要素を登録
customElements.define('chat-bubble', ChatBubbleElement);
