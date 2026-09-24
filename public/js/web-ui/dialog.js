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

/** Lucide の info（同上）。注意ではなく、ただの案内に使う。 */
const ICON_INFO = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="10"/>
  <path d="M12 16v-4"/>
  <path d="M12 8h.01"/>
</svg>`;

/**
 * alert() などの icon に渡せる絵。
 *
 *   dialog.alert("…", {icon: ICONS.info});
 *
 * 既定は注意の三角。何かを知らせるだけのときは info にする
 */
export const ICONS = Object.freeze({alert: ICON_ALERT, info: ICON_INFO});

const STYLE = `
/*
  使う側の CSS の影響を受けないよう、いったん全部を初期値へ戻す。

  ただし all:initial は書体や字の大きさまで戻してしまい、そのままだと
  ダイアログだけ別のフォントで出る。文字まわりは受け継ぎ直す
  （どの書体を使うかは、このファイルではなく使う側が決めること）
*/
:host {
    all: initial;
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
}

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
/* prompt の入力欄。form() が .content の中に作る入力は対象にしない */
.body > input:not(.is-shown) { display: none; }

/*
  長い説明の中身。読み物なので、縦に伸びすぎたら中だけを転がす。
  文字は本文より少し小さくして、一覧性を優先する
*/
.content {
    max-height: min(60vh, 460px);
    overflow-y: auto;
    overscroll-behavior: contain;
    font-size: 0.92em;
    line-height: 1.7;
}
.content:empty { display: none; }
.content > :first-child { margin-top: 0; }
.content > :last-child { margin-bottom: 0; }
.content h1, .content h2, .content h3 {
    margin: 1.2em 0 0.4em;
    font-size: 1em;
    font-weight: 800;
}
.content p, .content ul, .content ol { margin: 0.4em 0; }
.content ul, .content ol { padding-left: 1.4em; }
.content li { margin: 0.2em 0; }
.content a {
    color: var(--dialog-accent, #4b6bfb);
    overflow-wrap: anywhere;
}
.content code {
    padding: 1px 4px;
    border-radius: 4px;
    background: #eef1ff;
    font-size: 0.92em;
}
.content pre {
    margin: 0.4em 0;
    padding: 8px 10px;
    border-radius: 8px;
    background: #eef1ff;
    overflow-x: auto;
}
.content pre code { padding: 0; background: none; }
.content hr {
    margin: 1em 0;
    border: none;
    border-top: 2px dashed #e3e6f5;
}
/* 出典の一覧は「名前 → 参照先」の対応が多いので、表も整えておく */
.content table {
    width: 100%;
    border-collapse: collapse;
}
.content th, .content td {
    padding: 4px 6px;
    border-bottom: 1px solid #e3e6f5;
    text-align: left;
    vertical-align: top;
}

/* 読み物のときは少し広くする */
dialog.is-wide {
    width: min(560px, calc(100vw - 32px));
}

/*
  選ばせるときの一覧。1 件 1 ボタンで、押した時点で決まる。
  項目が増えても、.content の側で縦に転がる
*/
.choices {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.choice {
    display: block;
    width: 100%;
    padding: 12px 14px;
    border-radius: 12px;
    background: #eef1ff;
    text-align: left;
}
.choice:hover { background: #e3e6f5; }
.choice-label { font-weight: 700; }
/* 補足（説明や作者）。無ければ場所も取らない */
.choice-note {
    margin-top: 2px;
    font-size: 0.88em;
    opacity: 0.7;
    overflow-wrap: anywhere;
}
.choice-note:empty { display: none; }

/* 書き込ませるときの並び。ラベルと入力を縦に積む */
.fields {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.field {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.field > span {
    font-size: 0.88em;
    font-weight: 700;
    opacity: 0.7;
}
.field textarea {
    box-sizing: border-box;
    width: 100%;
    min-height: 4.5em;
    padding: 10px 12px;
    border: 2px solid #e3e6f5;
    border-radius: 12px;
    background: #fff;
    color: inherit;
    font: inherit;
    line-height: 1.5;
    resize: vertical;
}
.field textarea:focus {
    border-color: var(--dialog-accent, #4b6bfb);
    outline: none;
}

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
/* 下のボタン。choose() が .content の中に作るボタンは対象にしない */
.buttons > button:not(.is-shown) { display: none; }
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
     *
     * options に password: true を渡すと、伏せ字の入力欄になる。
     *
     * @returns {Promise<string|null>} 取り消した場合は null
     */
    prompt(message, options = {}) {
        return this._show({kind: "prompt", message, icon: "", ...options});
    }

    /**
     * 並べたものから 1 つ選んでもらう。
     *
     *   const command = await dialog.choose([
     *       {value: "open", label: "開く", note: "手元のファイルから"},
     *       {value: "save", label: "保存する"}
     *   ], {title: "ファイル"});
     *
     * 押した時点で決まる（決定ボタンは無い）。label と note は文字として
     * 差し込むので、外から来た名前をそのまま渡してよい。
     *
     * @param {Array<{value: *, label: string, note?: string}>} items
     * @param {object} [options] title / message / cancelText
     * @returns {Promise<*|null>} 取り消した場合は null
     */
    choose(items, options = {}) {
        return this._show({
            kind: "choose", message: "", icon: "", items, ...options
        });
    }

    /**
     * いくつかの項目を書き込んでもらう。
     *
     *   const values = await dialog.form([
     *       {name: "title", label: "名前", required: true},
     *       {name: "note",  label: "説明", multiline: true},
     *       {name: "password", label: "合言葉", password: true}
     *   ], {title: "公開する", okText: "公開する"});
     *
     * 空にできない項目は required を付ける（ブラウザが送信を止める）。
     *
     * @param {Array<object>} fields name / label / value / required /
     *                               multiline / password / placeholder
     * @param {object} [options] title / message / okText / cancelText
     * @returns {Promise<object|null>} 取り消した場合は null
     */
    form(fields, options = {}) {
        return this._show({
            kind: "form", message: "", icon: "", fields, ...options
        });
    }

    /**
     * 長い説明を出す。読むだけで、ボタンは閉じる 1 つ。
     *
     * 中身は HTML として差し込む。**渡す側が中身を信用できることを
     * 確かめること。** 外から来た文字をそのまま渡してはいけない
     * （このアプリでは、自分のサーバに置いたファイルだけを渡している）。
     *
     * @param {string} html
     * @param {object} [options] title / okText
     * @returns {Promise<void>}
     */
    info(html, options = {}) {
        return this._show({
            kind: "info", message: "", html, icon: "", wide: true, ...options
        }).then(() => undefined);
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
        <div class="content"></div>
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
            content: shadow.querySelector(".content"),
            input: shadow.querySelector("input"),
            ok: shadow.querySelector(".ok"),
            cancel: shadow.querySelector(".cancel")
        };
    }

    /**
     * 選ばせる一覧を組み立てる。押した時点で決まるので、決定ボタンは使わない。
     *
     * 文字は textContent で入れる。外から来た名前をそのまま渡せるようにするため
     */
    _buildChoices(content, items, decide) {
        const list = document.createElement("div");
        list.className = "choices";
        for (const item of items ?? []) {
            const button = document.createElement("button");
            // form の中のボタンは既定で submit になる。押した瞬間に閉じたいので外す
            button.type = "button";
            button.className = "choice";

            const label = document.createElement("div");
            label.className = "choice-label";
            label.textContent = String(item.label ?? item.value ?? "");
            const note = document.createElement("div");
            note.className = "choice-note";
            note.textContent = String(item.note ?? "");

            button.append(label, note);
            button.addEventListener("click", () => decide(item.value));
            list.appendChild(button);
        }
        content.appendChild(list);
        return list.querySelector("button");
    }

    /** 書き込ませる欄を組み立てる。戻り値は [名前, 入力欄] の並び。 */
    _buildFields(content, fields) {
        const list = document.createElement("div");
        list.className = "fields";
        const controls = [];
        for (const field of fields ?? []) {
            const label = document.createElement("label");
            label.className = "field";

            const caption = document.createElement("span");
            caption.textContent = String(field.label ?? field.name ?? "");

            const control = document.createElement(field.multiline ? "textarea" : "input");
            if (! field.multiline) {
                control.type = field.password ? "password" : "text";
            }
            control.value = String(field.value ?? "");
            control.placeholder = String(field.placeholder ?? "");
            // 空で決定させない項目。止めるのはブラウザの役目
            control.required = Boolean(field.required);

            label.append(caption, control);
            list.appendChild(label);
            controls.push([field.name, control]);
        }
        content.appendChild(list);
        return controls;
    }

    /**
     * 1 つ表示して、閉じるまで待つ。
     *
     * 決定なら入力された中身（alert と confirm では空文字、choose は選んだ値、
     * form は {名前: 中身}）、取り消しなら null を返す。Esc も取り消し
     */
    _show(options) {
        const run = () => new Promise((resolve) => {
            this._build();
            const {form, icon, title, message, content, input, ok, cancel} = this._parts;

            icon.innerHTML = options.icon ?? "";
            title.textContent = options.title ?? "";
            message.textContent = String(options.message ?? "");
            // info のときだけ HTML。渡す側が中身を確かめている前提
            content.innerHTML = options.html ?? "";

            // 中のリンクは別のタブで開く。同じタブで飛ぶと、開いていた画面を
            // まるごと離れてしまう（会話の途中なら、それまでのやり取りも消える）
            for (const link of content.querySelectorAll("a[href]")) {
                link.target = "_blank";
                link.rel = "noopener noreferrer";
            }
            this._dialog.classList.toggle("is-wide", Boolean(options.wide));

            const isPrompt = options.kind === "prompt";
            const isChoose = options.kind === "choose";
            const isForm = options.kind === "form";

            input.classList.toggle("is-shown", isPrompt);
            input.type = (isPrompt && options.password) ? "password" : "text";
            input.value = isPrompt ? String(options.defaultValue ?? "") : "";
            input.placeholder = options.placeholder ?? "";

            // 決定したかどうかは returnValue に混ぜず、ここで覚えておく。
            // 入力が空文字の prompt と、取り消しとを区別する必要があるため。
            // 返す中身も、文字とは限らないのでここで持つ
            let decided = false;
            let result = "";

            const decide = (value) => {
                decided = true;
                result = value;
                this._dialog.close("");
            };

            let firstControl = null;
            let controls = [];
            if (isChoose) {
                firstControl = this._buildChoices(content, options.items, decide);
            } else if (isForm) {
                controls = this._buildFields(content, options.fields);
                firstControl = controls[0]?.[1] ?? null;
            }

            ok.textContent = options.okText ?? (isPrompt || isForm ? "決定" : "OK");
            // choose は押した時点で決まるので、決定ボタンは出さない
            ok.classList.toggle("is-shown", ! isChoose);
            cancel.textContent = options.cancelText ?? "キャンセル";
            cancel.classList.toggle("is-shown",
                                    options.kind !== "alert" && options.kind !== "info");

            // method="dialog" の submit は returnValue にボタンの value を入れるが、
            // 入力した中身を返したいので自前で close() を呼ぶ。
            // 空にできない欄があるときは、ここへ来る前にブラウザが止める
            const onSubmit = (event) => {
                event.preventDefault();
                if (isPrompt) {
                    decide(input.value);
                } else if (isForm) {
                    decide(Object.fromEntries(
                        controls.map(([name, control]) => [name, control.value])));
                } else {
                    decide("");
                }
            };
            // 取り消し。Esc で閉じたときも decided は false のままここへ来る
            const onCancelClick = () => this._dialog.close("");

            const onClose = () => {
                form.removeEventListener("submit", onSubmit);
                cancel.removeEventListener("click", onCancelClick);
                this._dialog.removeEventListener("close", onClose);
                resolve(decided ? result : null);
            };

            form.addEventListener("submit", onSubmit);
            cancel.addEventListener("click", onCancelClick);
            this._dialog.addEventListener("close", onClose);

            this._dialog.returnValue = "";
            this._dialog.showModal();
            // 書き込む・選ぶものがあるならそこから始める。無ければ決定ボタン
            if (isPrompt) {
                input.select();
            } else if (firstControl) {
                firstControl.focus();
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
