

const _ChatFlowElementStyle_ = new CSSStyleSheet()
_ChatFlowElementStyle_.replaceSync(`
:host {
   /* ポップ＆ミニマル: 彩度の高い平面色を、ほぼ不透明で置く */
   --bubble-font-family: inherit;
   --bubble-font-size: var(--ui-font, clamp(12px, 2.4vw, 15px));
   --bubble-line-height: 1.5;
   --bubble-font-weight: 700;

   --left-bubble-font-color: #ffffff;
   --left-bubble-fill: var(--pop-pink, #ff5f8d);
   --left-bubble-fill-opacity: 0.92;

   --right-bubble-font-color: #ffffff;
   --right-bubble-fill: var(--pop-blue, #4b6bfb);
   --right-bubble-fill-opacity: 0.92;
}

chat-bubble {
   --font-family: var(--bubble-font-family);
   --font-size: var(--bubble-font-size);
   --line-height: var(--bubble-line-height);
   --font-weight: var(--bubble-font-weight);
}

chat-bubble.right {
   --font-color: var(--right-bubble-font-color);
   --fill: var(--right-bubble-fill);
   --fill-opacity: var(--right-bubble-fill-opacity);
}

chat-bubble.left {
   --font-color: var(--left-bubble-font-color);
   --fill: var(--left-bubble-fill);
   --fill-opacity: var(--left-bubble-fill-opacity);
}

.chat-messages {
   box-sizing: border-box;
   height: 100%;
   flex: 1;
   overflow-y: auto;
   /* 画面幅に応じた余白。上はクレジット表記を避ける */
   padding: clamp(38px, 8vw, 56px) clamp(12px, 3vw, 28px) clamp(12px, 3vw, 24px);

   /*
     下端を徐々に消す。マスクなので背景は透けたまま、
     吹き出しだけがフェードアウトする。
     フェードの高さは --bottom-fade で変更できる
   */
   -webkit-mask-image: linear-gradient(to bottom,
                           rgba(0,0,0,1) calc(100% - var(--bottom-fade, 60px)),
                           rgba(0,0,0,0) 100%);
   mask-image: linear-gradient(to bottom,
                   rgba(0,0,0,1) calc(100% - var(--bottom-fade, 60px)),
                   rgba(0,0,0,0) 100%);
}

.chat-messages::-webkit-scrollbar {
   width: 6px;
}

.chat-messages::-webkit-scrollbar-track {
   background: rgba(255, 255, 255, 0.1);
}

.chat-messages::-webkit-scrollbar-thumb {
   background: rgba(255, 255, 255, 0.3);
   border-radius: 3px;
}

.message-wrapper {
   display: flex;
   margin-bottom: clamp(8px, 2vw, 16px);
   animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
   from {
      opacity: 0;
      transform: translateY(10px);
   }
   to {
      opacity: 1;
      transform: translateY(0);
   }
}

.message-wrapper.right {
   justify-content: flex-end;
}
`);


class ChatFlowElement extends HTMLElement {

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.shadowRoot.adoptedStyleSheets = [_ChatFlowElementStyle_]
    }    

    connectedCallback() {
        // <div class="chat-messages">
        if (! document.querySelector(".chat-messages")) {
            const rootElement = document.createElement("div");
            rootElement.className = "chat-messages";
            this.shadowRoot.append(rootElement);
        }
    }

    appendMessage(message, type) {
        const rootElement = this.shadowRoot.firstElementChild;

        // message を HTML として挿入しない。LLM や音声認識の結果がそのまま入るため、
        // insertAdjacentHTML だとタグとして解釈されてしまう。
        // <chat-bubble> は textContent と <slot> しか使わないので、これで十分
        const bubbleElement = document.createElement("chat-bubble");
        bubbleElement.className = `message-wrapper ${type}`;
        bubbleElement.setAttribute("type", type);
        bubbleElement.textContent = message;   // 追加前に入れる（connectedCallback で採寸するため）
        rootElement.appendChild(bubbleElement);

        // スクロールを最下部へ
        rootElement.scrollTop = rootElement.scrollHeight;
    }

    clearMessages() {
        const rootElement = this.shadowRoot.firstElementChild;
        rootElement.querySelectorAll(":scope > chat-bubble").forEach((bubbleElement) => {
            bubbleElement.remove();
        });
    }
}

// カスタム要素を登録
customElements.define('chat-flow', ChatFlowElement);
