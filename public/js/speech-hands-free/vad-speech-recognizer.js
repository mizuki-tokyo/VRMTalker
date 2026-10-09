/**
 * 連続対話の音声認識。ボタンを押さなくても、話しかけるたびに聞き取る。
 *
 * SpeechRecognizer の実装（js/speech-recognizer.js）なので、会話の進行と
 * マイクボタンからは、ほかの実装と同じように扱える。違うのは次の 2 つ。
 *
 *   start()   連続対話を始める（マイクを開き、発話を待つ）。stop() まで続く
 *   listen()  発話の判定を始める。1 つの発話を聞き取ったら判定を止めるので、
 *             次の発話を聞くには、また呼ぶ（会話が入力待ちに戻ったときなど）
 *
 * 判定を止めている間（アバターが話している間など）は、アバターの声や効果音を
 * 拾わないよう、発話を探さない。マイクの音は溜め続ける。
 *
 *   マイク ─▶ AudioContext（16 kHz）─▶ 取り込み用 AudioWorklet（32 ミリ秒ずつ）
 *                                              │
 *                              リングバッファ（直近 5 秒）＋ Silero VAD
 *                                              │ 発話と決まった
 *                     少し前からの音 ＋ 続きの音 ─▶ UtteranceRecognizer（トラック経由）
 *
 * 使えるのは、音声認識に音（トラック）を渡せるブラウザだけ（track-support.js）。
 * 発話検出（onnxruntime-web と Silero VAD、約 14 MB）は、初めて start() した
 * ときに読み込む。使わない人の起動を重くしないため。
 *
 * イベント（SpeechRecognizer の約束に加えて）
 *   activechange  {active}  連続対話が始まった・終わった
 */
import SpeechRecognizer from "../speech-recognizer.js";
import RingBuffer from "./ring-buffer.js";
import SpeechDetector from "./speech-detector.js";
import UtteranceRecognizer from "./utterance-recognizer.js";
import {readCachedTrackSupport} from "./track-support.js";

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 512; // 32 ミリ秒（Silero VAD が 1 回に受け取る長さ）

// 溜めておくマイクの音の長さ（秒）
const RING_SECONDS = 5;

// インジケーターの値。volume-meter.js と同じ計算（RMS × 250、512 サンプルごとに 0.95 倍で減衰）
const LEVEL_SCALE = 250;
const LEVEL_DECAY = 0.95;

// 続けても同じく失敗するエラー。このときは連続対話を終える
// （話しかけるたびに失敗を繰り返さないように）
const FATAL_ERRORS = new Set([
    "not-allowed", "service-not-allowed", "audio-capture", "language-not-supported"
]);

const CAPTURE_URL = new URL("./worklets/capture-processor.js", import.meta.url);
const PLAYER_URL = new URL("./worklets/player-processor.js", import.meta.url);

// 発話検出は一度読み込めば使い回す（モデルの読み込みに時間がかかるため）
let vadPromise = null;
const loadVad = () => {
    vadPromise ??= import("./silero-vad.js")
        .then(({default: SileroVAD}) => SileroVAD.create())
        .catch((error) => {
            vadPromise = null; // 次にまた試せるように
            throw error;
        });
    return vadPromise;
};


export default class VadSpeechRecognizer extends SpeechRecognizer {

    /** このブラウザで使えると確かめてあるか。 */
    static isSupported() {
        return Boolean(readCachedTrackSupport()?.supported);
    }

    _lang;
    _session = null;      // {stream, context, capture, detector}
    _opening = null;      // マイクを開いている途中の Promise
    _utterance = null;    // 聞き取っている発話
    _listening = false;   // 発話を待つよう頼まれているか（聞き取っている間に頼まれたら、終わってから待つ）
    _level = 0;

    constructor(lang = "ja-JP") {
        super();
        this._lang = lang;
    }

    /** 連続対話をしているか（マイクボタンが、押したときに始めるか終えるかを決める）。 */
    get active() {
        return this._session !== null || this._opening !== null;
    }

    /** 連続対話を始める。すでに始まっていれば何もしない。 */
    start() {
        if (this.active) {
            return;
        }
        this._opening = this._open()
            .catch((error) => {
                console.error(error);
                this._close();
                this._emit("error", {code: "hands-free", message: error.message});
            })
            .finally(() => {
                this._opening = null;
            });
        this._emit("activechange", {active: true});
    }

    /** 連続対話を終える。聞き取っている途中の発話は取りやめる。 */
    stop() {
        if (! this.active) {
            return;
        }
        this._close();
    }

    /**
     * 次の発話を待つ。連続対話をしていなければ何もしない。
     * 前の発話の後片付けが済んでいなければ、済んでから待ち始める
     */
    listen() {
        if (! this.active) {
            return;
        }
        this._listening = true;
        if (! this._utterance) {
            this._session?.detector?.setDetecting(true);
        }
    }

    async _open() {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                // アバターの声や効果音がスピーカーから入るのを抑える
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        // 16 kHz で作れば、マイクの音の変換はブラウザに任せられる
        const context = new AudioContext({sampleRate: SAMPLE_RATE});
        const session = {stream, context, capture: null, detector: null};
        this._session = session;

        const [vad] = await Promise.all([
            loadVad(),
            context.audioWorklet.addModule(CAPTURE_URL),
            context.audioWorklet.addModule(PLAYER_URL)
        ]);
        if (this._session !== session) {
            return; // 準備を待つ間に終えられた（_close() が片付け済み）
        }

        const detector = new SpeechDetector(vad, new RingBuffer(SAMPLE_RATE * RING_SECONDS),
                                            {frameSize: FRAME_SIZE});
        detector.addEventListener("speechstart", (event) => this._beginUtterance(event.detail.audio));
        detector.addEventListener("speechframe", (event) => this._utterance?.push(event.detail.frame));
        detector.addEventListener("speechend", () => {
            // 確定を待つ間に次の発話を見つけて、認識が重ならないよう、すぐ判定を止める
            detector.setDetecting(false);
            this._emit("speechend");
            this._utterance?.finish();
        });

        const capture = new AudioWorkletNode(context, "speech-hands-free-capture", {
            processorOptions: {frameSize: FRAME_SIZE}
        });
        capture.port.onmessage = ({data: frame}) => {
            this._updateLevel(frame);
            detector.pushFrame(frame);
        };
        context.createMediaStreamSource(stream).connect(capture);
        // 出力は無音。出力先につないでおかないと、process() が呼ばれないブラウザがある
        capture.connect(context.destination);

        session.capture = capture;
        session.detector = detector;
        await context.resume();
        // 判定は、呼び出し側が listen() したときに始める（準備の間に頼まれていれば、ここで）
        if (this._listening) {
            detector.setDetecting(true);
        }
    }

    _close() {
        const session = this._session;
        this._session = null;
        this._listening = false;
        this._utterance?.abort();
        this._utterance = null;
        if (session) {
            session.capture?.disconnect();
            session.stream.getTracks().forEach((track) => track.stop());
            session.context.close().catch(() => {});
        }
        this._level = 0;
        this._emit("volumechange", {level: 0});
        this._emit("activechange", {active: false});
    }

    /** 発話と決まった。少し前からの音とともに、認識を始める。 */
    _beginUtterance(preroll) {
        const session = this._session;
        if (! session) {
            return;
        }
        // 1 つの発話を聞き取ったら、次に listen() されるまで待たない
        // （返事をしている間に、アバターの声などで次の発話を始めないように）
        this._listening = false;

        const utterance = new UtteranceRecognizer(session.context, {lang: this._lang});
        utterance.addEventListener("interimresult", (event) => this._emit("interimresult", event.detail));
        for (const type of ["result", "nomatch", "error"]) {
            utterance.addEventListener(type, (event) => this._emit(type, event.detail));
        }
        let fatal = false;
        utterance.addEventListener("error", (event) => {
            fatal = FATAL_ERRORS.has(event.detail.code);
        });
        utterance.addEventListener("end", () => {
            if (this._utterance !== utterance) {
                return; // 連続対話を終えたなどで、取りやめた発話
            }
            this._utterance = null;
            this._level = 0;
            this._emit("volumechange", {level: 0});
            this._emit("end");
            if (fatal) {
                this._close();
                return;
            }
            // 後片付けの間に listen() されていれば、ここから次の発話を待つ
            session.detector.setDetecting(this._listening);
        });
        this._utterance = utterance;

        this._emit("start");
        this._emit("speechstart");
        utterance.start(preroll);
    }

    /** インジケーターの値を更新する。判定している間（と、聞き取っている間）だけ出す。 */
    _updateLevel(frame) {
        if (! this._listening && ! this._utterance) {
            return;
        }
        let sum = 0;
        for (let i = 0; i < frame.length; i++) {
            sum += frame[i] * frame[i];
        }
        const rms = Math.sqrt(sum / frame.length);
        this._level = Math.max(rms, this._level * LEVEL_DECAY ** (frame.length / 512));
        this._emit("volumechange", {level: Math.min(100, this._level * LEVEL_SCALE)});
    }
}
