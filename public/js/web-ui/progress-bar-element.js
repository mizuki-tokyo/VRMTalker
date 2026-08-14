class ProgressBarElement extends HTMLElement {

    _valueElement = null;
    _titleElement = null;

    set value(_value) {
        if (_value === 100) {
            this._titleElement.innerText = "Loaded.";
        } else {
            this._titleElement.innerText = "Loading ...";
        }
        _value = `${_value}%`;
        this._valueElement.innerText = _value;
        this._valueElement.style.width = _value;
    }

    constructor() {
        super();
        const shadowRoot = this.attachShadow({mode: "open"});
        const divElement = document.createElement("div");
        shadowRoot.appendChild(divElement);
        divElement.innerHTML = `
<style>
      .title {
          font-size: 18px;
          font-weight: bold;
          color: dimgray;
          padding: 2px;
          margin: 0;
          text-align: center;
          text-shadow:1px 1px 0 #FFF, -1px -1px 0 #FFF,
              -1px 1px 0 #FFF, 1px -1px 0 #FFF,
              0px 1px 0 #FFF,  0-1px 0 #FFF,
              -1px 0 0 #FFF, 1px 0 0 #FFF;
      }
      .container {
          background-color: rgba(180,180,180,0.5);
          border-radius: 20px;
          overflow: hidden;
      }
      .progress {
          box-sizing: border-box;
          user-select: none;
          -webkit-user-select: none;
          background-color: #0099ff;
          color: white;
          padding: 1% 2% 1% 0;
          text-align: right;
          font-size: 10px;
          border-radius: 20px;
          box-shadow:
              4px 0px 6px #cceeff inset, /*内側左上ハイライト*/
              -4px -4px 6px #0077dd inset, /*内側右下シャドー*/
              -2px -2px 3px #cceeff, /*外側左上ぼかし*/
              2px 0px 3px #66ccff; /*外側右下ぼかし*/
      }
      .value {
          width: 0%;
      }
</style>
<div>
    <div class="container">
      <div class="progress value">0%</div>
    </div>
    <div class="title">Loading...</div>
</div>
`;
        this._valueElement = divElement.querySelector(".value");
        this._titleElement = this.shadowRoot.querySelector(".title");
    }
}

window.customElements.define("progress-bar", ProgressBarElement);
