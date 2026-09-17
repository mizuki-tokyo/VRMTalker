/**
 * window.alert / confirm / prompt の置き換え。
 *
 * 標準のダイアログは実行環境ごとに見た目が変わり、アプリの意匠と揃わない。
 * それに、開いている間はスクリプトが止まるため、裏で動いている処理
 * （音声の再生やアニメーション）まで巻き込んで固まる。
 *
 *   await dialog.alert("保存できませんでした");
 *   if (await dialog.confirm("閉じますか？")) { ... }
 *   const name = await dialog.prompt("名前は？", {defaultValue: "ずんだもん"});
 *
 * 待てる形にしたので、呼び出し側は await を付けるだけで済む。
 *
 *
 * 実装について
 * ------------
 * 中身は <dialog> の showModal()。自前で半透明の板を重ねるより、こちらの
 * ほうが確実に動く。
 *
 *   - 最前面に出る（top layer）。z-index の取り合いにならない
 *   - 外側を操作できなくなり、Tab の移動もダイアログの中に閉じる
 *   - Esc で閉じられる
 *   - 背景は ::backdrop で塗れる
 *
 * 見た目は Shadow DOM に閉じてあるので、使う側の CSS とぶつからない。
 * 色や角の丸みは下のカスタムプロパティで変えられる（継承はシャドウ境界を
 * 越えるので、使う側の :root に書けば届く）。
 *
 *   --dialog-surface    土台の色
 *   --dialog-ink        文字色
 *   --dialog-accent     主ボタンの色
 *   --dialog-backdrop   背景を覆う色
 *   --dialog-radius     角の丸み
 *
 * このファイルはプロジェクトに依存しない。import も持たない。
 */

/** Lucide の triangle-alert（ISC ライセンス）。取りに行かせず埋め込む。 */
const ICON_ALERT = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>
  <path d="M12 9v4"/>
  <path d="M12 17h.01"/>
</svg>`;

const STYLE = `
:host { all: initial; }

dialog {
    box-sizing: border-box;
    width: min(420px, calc(100vw - 32px));
    padding: 0;
    border: none;
    border-radius: var(--dialog-radius, 18px);
    background: var(--dialog-surface, #fff);
    color: var(--dialog-ink, #23244a);
    font: inherit;
    font-family: inherit;
    box-shadow: 0 12px 32px rgba(35, 36, 74, 0.25);
}
dialog::backdrop {
    background: var(--dialog-backdrop, rgba(35, 36, 74, 0.45));
}

/* 開くときだけ軽く動かす。閉じるときは待たせない */
dialog[open] {
    animation: pop 0.14s ease-out;
}
@keyframes pop {
    from { opacity: 0; transform: translateY(6px) scale(0.98); }
}
@media (prefers-reduced-motion: reduce) {
    dialog[open] { animation: none; }
}

form {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin: 0;
    padding: 20px;
}

.head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
}
.icon {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    color: var(--dialog-accent, #4b6bfb);
}
.icon svg { width: 100%; height: 100%; }
.icon:empty { display: none; }

.body {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.title {
    margin: 0;
    font-size: 1.05em;
    font-weight: 800;
}
.title:empty { display: none; }

/* メッセージは改行と長い語をそのまま受ける */
.message {
    margin: 0;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

input {
    box-sizing: border-box;
    width: 100%;
    padding: 10px 12px;
    border: 2px solid #e3e6f5;
    border-radius: 12px;
    background: #fff;
    color: inherit;
    font: inherit;
}
input:focus {
    border-color: var(--dialog-accent, #4b6bfb);
    outline: none;
}
input:not(.is-shown) { display: none; }

.buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}
button {
    padding: 9px 18px;
    border: none;
    border-radius: 999px;
    background: #e3e6f5;
    color: inherit;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
}
button.primary {
    background: var(--dialog-accent, #4b6bfb);
    color: #fff;
}
button:focus-visible {
    outline: 2px solid var(--dialog-accent, #4b6bfb);
    outline-offset: 2px;
}
button:not(.is-shown) { display: none; }
`;


export class Dialog {

    _host = null;
    _dialog = null;
    _parts = null;

    // 同時に開けないので、前のものが閉じるまで待たせる
    _queue = Promise.resolve();

    /**
     * 知らせるだけ。
     * @param {string} message
     * @param {object} [options] title / okText / icon
     * @returns {Promise<void>}
     */
    alert(message, options = {}) {
        return this._show({
            kind: "alert", message, icon: ICON_ALERT, ...options
        }).then(() => undefined);
    }

    /**
     * はい / いいえ。
     * @returns {Promise<boolean>} Esc で閉じた場合は false
     */
    confirm(message, options = {}) {
        return this._show({
            kind: "confirm", message, icon: ICON_ALERT, ...options
        }).then((result) => result !== null);
    }

    /**
     * 文字を入れてもらう。
     * @returns {Promise<string|null>} 取り消した場合は null
     */
    prompt(message, options = {}) {
        return this._show({kind: "prompt", message, icon: "", ...options});
    }

    /** 開いているダイアログを取り消し扱いで閉じる。画面を切り替えるときなどに。 */
    dismiss() {
        if (this._dialog?.open) {
            this._dialog.close("");
        }
    }

    //---------------------------------- 内部

    _build() {
        if (this._host) {
            return;
        }
        this._host = document.createElement("div");
        const shadow = this._host.attachShadow({mode: "open"});
        shadow.innerHTML = `
<style>${STYLE}</style>
<dialog>
  <form method="dialog">
    <div class="head">
      <div class="icon"></div>
      <div class="body">
        <h2 class="title"></h2>
        <p class="message"></p>
        <input type="text">
      </div>
    </div>
    <div class="buttons">
      <button type="button" class="cancel"></button>
      <button type="submit" class="ok primary"></button>
    </div>
  </form>
</dialog>`;
        document.body.appendChild(this._host);

        this._dialog = shadow.querySelector("dialog");
        this._parts = {
            form: shadow.querySelector("form"),
            icon: shadow.querySelector(".icon"),
            title: shadow.querySelector(".title"),
            message: shadow.querySelector(".message"),
            input: shadow.querySelector("input"),
            ok: shadow.querySelector(".ok"),
            cancel: shadow.querySelector(".cancel")
        };
    }

    /**
     * 1 つ表示して、閉じるまで待つ。
     *
     * 決定なら入力した文字（alert と confirm では空文字）、取り消しなら null
     * を返す。Esc も取り消しとして扱う
     */
    _show(options) {
        const run = () => new Promise((resolve) => {
            this._build();
            const {form, icon, title, message, input, ok, cancel} = this._parts;

            icon.innerHTML = options.icon ?? "";
            title.textContent = options.title ?? "";
            message.textContent = String(options.message ?? "");

            const isPrompt = options.kind === "prompt";
            input.classList.toggle("is-shown", isPrompt);
            input.value = isPrompt ? String(options.defaultValue ?? "") : "";
            input.placeholder = options.placeholder ?? "";

            ok.textContent = options.okText ?? (isPrompt ? "決定" : "OK");
            ok.classList.add("is-shown");
            cancel.textContent = options.cancelText ?? "キャンセル";
            cancel.classList.toggle("is-shown", options.kind !== "alert");

            // 取り消しは空の returnValue で表す。Esc もここに来る
            // （method="dialog" の submit は returnValue にボタンの value が入るが、
            //   入力した文字を返したいので自前で close() を呼ぶ）
            const onSubmit = (event) => {
                event.preventDefault();
                this._dialog.close(isPrompt ? `${input.value}` : "");
            };
            const onCancelClick = () => this._dialog.close("");

            const onClose = () => {
                form.removeEventListener("submit", onSubmit);
                cancel.removeEventListener("click", onCancelClick);
                this._dialog.removeEventListener("close", onClose);
                const value = this._dialog.returnValue;
                resolve(value.startsWith("") ? value.slice(1) : null);
            };

            form.addEventListener("submit", onSubmit);
            cancel.addEventListener("click", onCancelClick);
            this._dialog.addEventListener("close", onClose);

            this._dialog.returnValue = "";
            this._dialog.showModal();
            // 入力欄があるならそこから始める。無ければ決定ボタン
            if (isPrompt) {
                input.select();
            } else {
                ok.focus();
            }
        });

        // 前のダイアログが閉じてから開く。showModal() は二重に呼べない
        this._queue = this._queue.then(run, run);
        return this._queue;
    }
}

/** 使い回す 1 つ。ふつうはこちらを import する。 */
const dialog = new Dialog();

export default dialog;
