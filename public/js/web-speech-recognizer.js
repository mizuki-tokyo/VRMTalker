/**
 * Web Speech API を使った音声認識。
 *
 * SpeechRecognizer の実装。ブラウザ内蔵の認識エンジンを使うので、サーバ側に
 * 何も用意しなくても動く代わりに、対応ブラウザが Chrome / Safari 系に限られる。
 *
 * 認識結果の表示は行わない。呼び出し側が onresult を受けて画面に反映する。
 */

import SpeechRecognizer from "./speech-recognizer.js";
import VolumeMeter from "./speech-recognizer/volume-meter.js";


// window 経由で参照する。Firefox のように未実装のブラウザでは、
// 裸の webkitSpeechRecognition と書くと ReferenceError になってしまう
const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;


class WebSpeechRecognizer extends SpeechRecognizer {

    _recognition = null;
    _context = null;

    // この回の認識の結末（result / nomatch / error）を、もう知らせたか。
    // 結末を知らせないまま終わったときに、nomatch を出すために使う
    _settled = false;

    // stop() で止めているところか。止めた後のエラーや nomatch は知らせない
    // （止めたのはこちらの都合なので、失敗ではない）
    _stopping = false;

    // マイクの取り込みの最中か（音量の測定を動かしているか）
    _capturing = false;

    /** このブラウザで Web Speech API が使えるか。 */
    static isSupported() {
        return Boolean(SpeechRecognitionApi);
    }

    constructor(lang = "ja-JP") {
        super();

        if (! WebSpeechRecognizer.isSupported()) {
            throw new Error(
                "このブラウザは Web Speech API に対応していません。"
                + "Chrome / Safari などで開くか、別の SpeechRecognizer 実装を注入してください。");
        }

        this._recognition = new SpeechRecognitionApi();
        this._recognition.lang = lang;
        this._recognition.interimResults = true; // 途中結果を返す
        // 一度話して確定したら、そこで認識を終える。Chrome・Edge・Safari のどれも、
        // 確定した結果と同時に自然に終わる。
        //
        // 以前は、Safari が false で連続認識のように振る舞ったため、true にして
        // 確定したら stop() で止めていた。いまの Safari（26）は false で問題ない。
        // 一方 Edge は、stop() で止めると数秒後に "network" エラーを出し、連続認識
        // の間は約 5 秒ごとに空の確定結果を出す（話し始めと重なると言葉が失われる）
        this._recognition.continuous = false;

        this._setup();
    }

    start() {
        if (! this._context) {
            this._context = new AudioContext();
        }
        this._settled = false;
        this._stopping = false;
        this._recognition.start();
    }

    stop() {
        this._stopping = true;
        this._recognition.stop();
    }

    /** 音量の測定を止め、レベル表示を消して、end を知らせる（一度だけ）。 */
    _endCapture() {
        if (! this._capturing) {
            return;
        }
        this._capturing = false;
        VolumeMeter.stopAudio();
        // レベル表示を消す。認識の後始末が終わってから通知する
        setTimeout(() => this._emit("volumechange", {level: 0}), 0);
        this._emit("end");
    }

    /** この回の結末を知らせる（一度だけ）。止めている途中なら知らせない。 */
    _settle(type, detail) {
        if (this._settled) {
            return;
        }
        this._settled = true;
        if (! this._stopping) {
            this._emit(type, detail);
        }
    }

    _setup() {
        // マイクが実際に開いた時点を「認識開始」とする。
        // start() を呼んだ直後ではなく、権限の確認などが済んだ後に来る
        this._recognition.onaudiostart = (e) => {
            this._capturing = true;
            VolumeMeter.onvolumechange = (level) => this._emit("volumechange", {level});
            VolumeMeter.startAudio(this._context);
            this._emit("start");
        };

        // マイクの取り込みの終わり。Safari は continuous = false のとき audioend を
        // 出さないので、認識の終わり（end）でも同じ後始末をする（先に来たほうで一度だけ）
        this._recognition.onaudioend = (e) => {
            this._endCapture();
        };

        // 発話区間。Web Speech API は検出できるが、実装によっては取れない
        this._recognition.onspeechstart = (e) => {
            this._emit("speechstart");
        };

        this._recognition.onspeechend = (e) => {
            this._emit("speechend");
        };

        this._recognition.onnomatch = (e) => {
            this._settle("nomatch");
        };

        this._recognition.onerror = (e) => {
            this._settle("error", {code: e.error, message: e.message || e.error});
        };

        this._recognition.onresult = (event) => {
            const results = event.results;
            let text = "";
            for (let i = event.resultIndex; i < results.length; i++) {
                text += results[i/*何番目の音節*/][0/*第一候補*/].transcript;
                if (results[i].isFinal === true) {
                    // 空の確定結果は発話として扱わない（Edge は無音の区切りで出す）。
                    // 何も言わずに終われば、onend が nomatch を出す
                    if (text.trim() !== "") {
                        this._settle("result", {text});
                    }
                    return;
                }
            }
            this._emit("interimresult", {text});
        };

        // 結末（結果・聞き取れなかった・エラー）を知らせないまま終わったら、
        // 聞き取れなかったことにする。黙っていたときなど、ブラウザによっては
        // 何も知らせずに終わるため。知らせないと、会話が入力待ちに戻らない
        this._recognition.onend = (e) => {
            this._endCapture();
            this._settle("nomatch");
        };
    }
}

export default WebSpeechRecognizer;
