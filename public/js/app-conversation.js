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
 *   thinkingstart  返事を待ち始めた（LLM に頼んだ）     detail: なし
 *   thinkingend    返事の最初の一文が届いた（または失敗・中断）  detail: なし
 *
 * speechstart / speechend は音声認識の実装によっては出ない（js/speech-recognizer.js 参照）。
 *
 * thinkingstart / thinkingend は画面の表示（考え中の吹き出し）のためのもので、
 * アクションのイベントにはしていない。返事を同時に複数待っていても、
 * 待ち始めと、全部が届いたときに 1 回ずつ出す。
 *
 * 応答ターンや応答文ごとのイベントは設けていない。応答の流れそのものを
 * アクション側に書いてもらうほうが、上から下に読める形になるため
 * （replySentences() を参照）。
 *
 * 返事の感情（LLM が返事の最初に付ける絵文字。js/emotion.js）もここで読み取り、
 * replyEmotion に覚えておく。返す文からは絵文字を取り除き、showEmotionEmoji が
 * true なら、読み取った感情の絵文字を 1 つだけ文の頭に付け直す。
 */

import {readEmotion, stripEmoji, emotionEmoji} from "./emotion.js";

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

    // 最初の一文を待っている返事の数
    _thinkingCount = 0;

    // 直近の返事の感情（js/emotion.js の id）。分からなければ null
    _replyEmotion = null;

    /** 返事の文の頭に、感情の絵文字を付けるか（設定の「表示」）。 */
    showEmotionEmoji = true;

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

    /**
     * 直近の返事の感情（js/emotion.js の EMOTIONS の id）。分からなければ null。
     * 返事を頼むたびに null に戻り、感情の絵文字が届いた時点で決まる
     * （ふつうは最初の一文）
     */
    get replyEmotion() {
        return this._replyEmotion;
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
        // 最初の一文が届くまでを「考え中」とする。失敗したときや、
        // 読み手が途中でやめたときも、finally で必ず終える
        let thinking = true;
        this._setThinking(+1);
        this._replyEmotion = null;
        try {
            for await (const sentence of this._chatClient.stream(text)) {
                if (thinking) {
                    thinking = false;
                    this._setThinking(-1);
                }
                const shown = this._readSentence(sentence);
                // 絵文字だけの文（「😄」など）は、取り除くと空になるので返さない
                if (shown) {
                    yield shown;
                }
            }
        } catch (error) {
            console.error(error);
            this._emit("error", {phase: PHASE.chat, message: error.message});
        } finally {
            if (thinking) {
                this._setThinking(-1);
            }
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

    /**
     * 返事の 1 文から感情を読み取り、返す形にする。
     *
     * 感情は、返事の中で最初に見つかったものだけを使う。小さなモデルは
     * 余分な絵文字を付けがちなので、文からは絵文字をすべて取り除き、
     * 表示するときは読み取った感情の絵文字を 1 つだけ付け直す
     */
    _readSentence(sentence) {
        const emotion = (this._replyEmotion === null) ? readEmotion(sentence) : null;
        if (emotion) {
            this._replyEmotion = emotion;
        }
        const plain = stripEmoji(sentence);
        if (plain && emotion && this.showEmotionEmoji) {
            return `${emotionEmoji(emotion)} ${plain}`;
        }
        return plain;
    }

    /** 待っている返事の数を増減し、0 との間を行き来したら知らせる。 */
    _setThinking(change) {
        const before = this._thinkingCount;
        this._thinkingCount = Math.max(0, before + change);
        if (before === 0 && this._thinkingCount > 0) {
            this._emit("thinkingstart");
        } else if (before > 0 && this._thinkingCount === 0) {
            this._emit("thinkingend");
        }
    }

    _emit(type, detail = null) {
        this.dispatchEvent(new CustomEvent(type, {detail}));
    }
}

export default Conversation;
