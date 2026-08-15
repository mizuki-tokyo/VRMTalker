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
//import VolumeMeter from "./speech-recognizer/volume-meter-worklet.js";


// window 経由で参照する。Firefox のように未実装のブラウザでは、
// 裸の webkitSpeechRecognition と書くと ReferenceError になってしまう
const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;


class WebSpeechRecognizer extends SpeechRecognizer {

    _recognition = null;
    _context = null;

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
        // safari では、SpeechRecognition#continuous を false にすると、
        // 連続音声認識モードになるため、true にして
        // SpeechRecognition#stop() で制御する
        this._recognition.continuous = true;

        this._setup();
    }

    start() {
        if (! this._context) {
            this._context = new AudioContext();
        }
        this._recognition.start();
    }

    stop() {
        this._recognition.stop();
    }

    _setup() {
        this._recognition.onaudiostart = (e) => {
            // ハンドラを直接渡さず包んでおく。呼び出し側が後から
            // onvolumechange を差し替えても、常に最新のものが呼ばれる
            VolumeMeter.onvolumechange = (level) => this.onvolumechange(level);
            VolumeMeter.startAudio(this._context);
        };

        this._recognition.onaudioend = (e) => {
            VolumeMeter.stopAudio();
            // レベル表示を消す。認識の後始末が終わってから通知する
            setTimeout(() => this.onvolumechange(0), 0);
        };

        this._recognition.onnomatch = (e) => {
            this.onnomatch(e);
        };

        this._recognition.onerror = (e) => {
            this.onerror(e);
        };

        this._recognition.onresult = (event) => {
            const results = event.results;
            for (let i = event.resultIndex; i < results.length; i++) {
                const transcript = results[i][0].transcript;
                const isFinal = (results[i].isFinal === true);

                this.onresult(transcript, isFinal);

                if (isFinal) {
                    setTimeout(() => this._recognition.stop(), 0);
                }
            }
        };
    }
}

export default WebSpeechRecognizer;
