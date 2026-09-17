/**
 * 会話の進行。
 *
 * 音声認識と応答生成をまとめ、会話の節目をイベントとして出す。
 * 「そのときアバターが何をするか」はここには書かない（app-avatar-actions.js の担当）。
 *
 * イベントの発生元を window ではなくこのオブジェクトにしているのは、
 * 直近の発話などの状態を持つ主体が必要で、かつ将来 2 体目のアバターや
 * 記録した会話の再生といった使い方を塞がないようにするため。
 *
 * イベント
 *   ready       準備ができた（モデルの読み込み完了）  detail: なし
 *   idle        入力待ちに入った                      detail: なし
 *   listenstart 音声認識が始まった                    detail: なし
 *   speechstart ユーザが話し始めた                    detail: なし  ※任意
 *   speechend   ユーザが話し終わった                  detail: なし  ※任意
 *   listenend   発話が確定した                        detail: {text}
 *   error       失敗した                              detail: {phase, message}
 *
 * speechstart / speechend は音声認識の実装によっては出ない（js/speech-recognizer.js 参照）。
 *
 * 応答ターンや応答文ごとのイベントは設けていない。応答の流れそのものを
 * アクション側に書いてもらうほうが、上から下に読める形になるため
 * （replySentences() を参照）。
 */

/** error イベントの phase。どこで失敗したかを表す。 */
export const PHASE = Object.freeze({
    recognize: "recognize",  // 音声認識
    chat: "chat",            // 応答の生成
    speak: "speak"           // 音声合成・再生
});


class Conversation extends EventTarget {

    _chatClient = null;

    _recognizer = null;
    _recognizerListeners = null;

    // 直近のユーザの発話。アクションから参照する
    _userText = "";

    _idle = false;

    /**
     * @param {object} deps
     * @param {object} deps.chatClient ChatClient
     */
    constructor({chatClient}) {
        super();
        this._chatClient = chatClient;
    }

    /** 直近のユーザの発話。 */
    get userText() {
        return this._userText;
    }

    /** 今が入力待ちかどうか。 */
    get isIdle() {
        return this._idle;
    }

    /** キャラクタの名前。設定ウインドウで決めたものが入っている。 */
    get characterName() {
        return this._chatClient.persona.name;
    }

    /**
     * 音声認識の実装を設定する。
     *
     * 代入ではなく addEventListener で購読するので、呼び出し側が recognizer の
     * onXXX に別のハンドラを付けていても潰さない。
     */
    set recognizer(recognizer) {
        this._unbindRecognizer();
        this._recognizer = recognizer || null;
        if (this._recognizer) {
            this._bindRecognizer(this._recognizer);
        }
    }

    get recognizer() {
        return this._recognizer;
    }

    /**
     * 会話を始める（始め直す）。モデルの読み込み後と、ブロックの編集から
     * 戻ったときに呼ぶ。
     *
     * 編集中は会話を止めているので、待機に入り直さないと「待機に入ったとき」
     * のブロックが二度と動かない。enterIdle() は二重発火を防ぐため入力待ちの
     * ままだと素通りするので、ここで解いてから呼ぶ。
     *
     * ready を出したときは、ここで待機へは入らない。「準備ができたとき」の
     * アクションが終わってから入る（app.js が完了を見て enterIdle を呼ぶ）。
     * でないと、あいさつを喋っている最中に待機の仕草が始まってしまう。
     *
     * @param {boolean} [fireReady] 「準備ができたとき」から動かすか。
     *        false なら、そのまま待機へ入る
     */
    restart(fireReady = true) {
        this._idle = false;
        if (fireReady) {
            this._emit("ready");
        } else {
            this.enterIdle();
        }
    }

    /**
     * 入力待ちに入ったことを知らせる。
     *
     * 応答のアクションが終わった時点で呼ぶ。二重には発火しない。
     */
    enterIdle() {
        if (this._idle) {
            return;
        }
        this._idle = true;
        this._emit("idle");
    }

    /**
     * 応答を一文ずつ返す。
     *
     * 文が完成した順に届くので、生成の完了を待たずに話し始められる。
     * 失敗しても例外は投げず、error イベントを出して終わる
     * （アクションを書く人に try/catch を求めないため）。
     *
     *   for await (const sentence of conversation.replySentences(text)) { ... }
     *
     * @param {string} text 返事のもとになる発話
     */
    async *replySentences(text) {
        try {
            for await (const sentence of this._chatClient.stream(text)) {
                yield sentence;
            }
        } catch (error) {
            console.error(error);
            this._emit("error", {phase: PHASE.chat, message: error.message});
        }
    }

    /** 会話の履歴を消す。 */
    clearHistory() {
        this._chatClient.clearHistory();
    }

    _bindRecognizer(recognizer) {
        this._recognizerListeners = {
            start: () => {
                this._idle = false;
                this._emit("listenstart");
            },
            speechstart: () => this._emit("speechstart"),
            speechend: () => this._emit("speechend"),
            result: (event) => {
                this._userText = event.detail.text;
                this._emit("listenend", {text: this._userText});
            },
            nomatch: () => {
                this._emit("error",
                           {phase: PHASE.recognize, message: "聞き取れませんでした。"});
                this.enterIdle();
            },
            error: (event) => {
                this._emit("error",
                           {phase: PHASE.recognize, message: event.detail.message});
                this.enterIdle();
            }
        };
        for (const [type, listener] of Object.entries(this._recognizerListeners)) {
            recognizer.addEventListener(type, listener);
        }
    }

    _unbindRecognizer() {
        if (! this._recognizer || ! this._recognizerListeners) {
            return;
        }
        for (const [type, listener] of Object.entries(this._recognizerListeners)) {
            this._recognizer.removeEventListener(type, listener);
        }
        this._recognizerListeners = null;
    }

    _emit(type, detail = null) {
        this.dispatchEvent(new CustomEvent(type, {detail}));
    }
}

export default Conversation;
