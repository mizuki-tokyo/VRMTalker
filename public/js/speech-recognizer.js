/**
 * 音声認識の抽象クラス。
 *
 * 認識結果は EventTarget のイベントとして通知する。認識方式を差し替えたいときは
 * このクラスを継承した実装を作り、app.js で生成するものを変えればよい。
 * <speech-recognition> 要素はこのファイルを import しないので、実装を増やしても
 * UI には手を入れなくて済む。
 *
 *   class MyRecognizer extends SpeechRecognizer {
 *       start() { ... 認識を始め、結果が出たら this._emit("result", {text}) ... }
 *       stop()  { ... }
 *   }
 *
 *   // app.js
 *   const recognizer = new MyRecognizer();
 *   recognizer.onresult = (event) => console.log(event.detail.text);
 *   document.querySelector("speech-recognition").recognizer = recognizer;
 *
 * イベント
 *   start         認識を開始した        detail: なし
 *   speechstart   発話区間の開始        detail: なし  ※任意
 *   speechend     発話区間の終了        detail: なし  ※任意
 *   result        確定した認識結果      detail: {text}
 *   interimresult 認識中の途中経過      detail: {text}
 *   volumechange  入力レベル (0-100)    detail: {level}
 *   error         認識に失敗した        detail: {code, message}
 *   nomatch       結果を確定できなかった detail: なし
 *   end           認識を終了した        detail: なし
 *   activechange  連続対話が始まった・終わった  detail: {active}  ※連続対話の実装のみ
 *
 * 受け取り方は 2 通りある。DOM のイベントと同じで、両方を同時に使える。
 *
 *   recognizer.onresult = (event) => {};              // 代入。後の代入で置き換わる
 *   recognizer.addEventListener("result", (e) => {}); // 追加。何個でも登録できる
 *
 * 要素は addEventListener で購読するので、呼び出し側が onresult に代入しても
 * 互いを潰さない。
 *
 * 実装が満たすべき約束
 *   - start() を呼ばれたら認識を始め、実際に始まったら start を出す
 *   - 確定前の結果は interimresult で流してよい（流さなくてもよい）
 *   - 確定したら result を必ず一度出す
 *   - 認識が終わったら end を必ず一度出す
 *   - 入力レベルを取れるなら volumechange で流す。取れなければ出さなくてよい
 *   - 認識が終わったら level 0 の volumechange を出してレベル表示を消す
 *
 * speechstart / speechend（ユーザが話し始めた・話し終えた）は任意とする。
 * 発話区間を取れない実装（録音してまとめてサーバへ送る方式など）があるため、
 * 受け取る側はこれらが来ないことを前提に作ること。
 *
 * 連続対話の実装（speech-hands-free/vad-speech-recognizer.js）は、さらに
 * 次を持つ。start() で始めたら stop() まで続き、その間は発話のたびに
 * start → result（または nomatch / error）→ end を繰り返す。
 *   active          続いているか。マイクボタンは、これで始める・終えるを切り替える
 *   listen()        次の発話を待つ（会話が入力待ちに戻ったときに呼ぶ）
 *   activechange    続いているかが変わったときのイベント
 */

/** onXXX として代入できるイベント。 */
const HANDLER_EVENT_TYPES = Object.freeze([
    "start", "speechstart", "speechend",
    "result", "interimresult", "volumechange", "error", "nomatch",
    "end", "activechange"
]);


class SpeechRecognizer extends EventTarget {

    // onXXX に代入されたハンドラ。addEventListener で足したものとは別に管理し、
    // 代入し直したときに前のものだけを外せるようにする
    _handlers = new Map();

    constructor() {
        super();
        if (new.target === SpeechRecognizer) {
            throw new Error(
                "SpeechRecognizer は抽象クラスです。継承した実装を生成してください。");
        }
    }

    /** 認識を開始する。 */
    start() {
        throw new Error(`${this.constructor.name}: start() が実装されていません。`);
    }

    /** 認識を停止する。 */
    stop() {
        throw new Error(`${this.constructor.name}: stop() が実装されていません。`);
    }

    /**
     * イベントを発火する。実装クラスから呼ぶ。
     * @param {string} type
     * @param {object} [detail]
     */
    _emit(type, detail = null) {
        this.dispatchEvent(new CustomEvent(type, {detail}));
    }

    _setHandler(type, handler) {
        const previous = this._handlers.get(type);
        if (previous) {
            this.removeEventListener(type, previous);
            this._handlers.delete(type);
        }
        if (typeof handler === "function") {
            this._handlers.set(type, handler);
            this.addEventListener(type, handler);
        }
    }

    _getHandler(type) {
        return this._handlers.get(type) ?? null;
    }
}

// onresult / oninterimresult / ... を、内部のリスナー 1 個として実装する。
// DOM のイベントハンドラ属性と同じ挙動になる
for (const type of HANDLER_EVENT_TYPES) {
    Object.defineProperty(SpeechRecognizer.prototype, `on${type}`, {
        get() { return this._getHandler(type); },
        set(handler) { this._setHandler(type, handler); },
        enumerable: true,
        configurable: true
    });
}

export default SpeechRecognizer;
