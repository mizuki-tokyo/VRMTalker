/**
 * 1 つの発話を、トラック経由で音声認識（Web Speech API）に渡して認識する。
 *
 *   再生用 AudioWorklet ─▶ MediaStreamAudioDestinationNode ─▶ トラック
 *                                                              │
 *                                          SpeechRecognition.start(track)
 *
 *   const utterance = new UtteranceRecognizer(context, {lang: "ja-JP"});
 *   utterance.start(preroll);   // 発話と決まった時点で、少し前からの音を渡す
 *   utterance.push(frame);      // 続きの音
 *   utterance.finish();         // 発話が終わった（あとは確定を待つ）
 *
 * 締めくくり方は、Chrome・Edge で確かめた結果に合わせてある。
 *
 *   - continuous = false にし、stop() は呼ばない。流す音が無い間も無音を流し
 *     続ける（再生用 AudioWorklet がそうする）ので、話し終えた後の無音を聞いて
 *     自然に確定する。Edge は stop() で止めると "network" エラーを出す
 *   - それでも確定しないときに備え、finish() から一定時間で打ち切る。そのときは
 *     途中の結果を最終の結果として扱う（途中の結果には全文が届いていた）
 *
 * AudioContext は 16 kHz で作り、再生用 AudioWorklet（worklets/player-processor.js）
 * を読み込んでおくこと。Edge は 48 kHz の音だと、結果が空になる。
 *
 * イベント（結末は result / nomatch / error のどれか 1 つ。end は必ず最後に 1 回）
 *   interimresult  {text}
 *   result         {text}
 *   nomatch
 *   error          {code, message}
 *   end
 */

const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;

// finish() の後、これだけ待っても終わらなければ打ち切る（ミリ秒）
const FINALIZE_TIMEOUT_MS = 6000;

export default class UtteranceRecognizer extends EventTarget {

    _settled = false;
    _ended = false;
    _interimText = "";
    _timer = null;

    /**
     * @param {AudioContext} context 16 kHz。再生用 AudioWorklet を読み込み済みのもの
     * @param {object} options
     * @param {string} options.lang 認識する言語
     */
    constructor(context, {lang}) {
        super();
        this._player = new AudioWorkletNode(context, "speech-hands-free-player", {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1]
        });
        this._destination = context.createMediaStreamDestination();
        this._destination.channelCount = 1;
        this._player.connect(this._destination);
        this._track = this._destination.stream.getAudioTracks()[0];

        const recognition = new SpeechRecognitionApi();
        recognition.lang = lang;
        recognition.continuous = false;
        recognition.interimResults = true;

        recognition.onresult = (event) => {
            let text = "";
            for (let i = event.resultIndex; i < event.results.length; i++) {
                text += event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    // 空の確定結果は発話として扱わない（end で、途中の結果か nomatch にする）
                    if (text.trim() !== "") {
                        this._settle("result", {text});
                    }
                    return;
                }
            }
            this._interimText = text;
            this._emit("interimresult", {text});
        };
        recognition.onnomatch = () => {
            this._settle("nomatch");
        };
        recognition.onerror = (event) => {
            if (event.error === "no-speech") {
                this._settle("nomatch");
            } else if (event.error !== "aborted") {
                // aborted は自分で打ち切ったとき。end で結末を決める
                this._settle("error", {code: event.error, message: event.message || event.error});
            }
        };
        recognition.onend = () => {
            // 確定しないまま終わった。途中の結果があれば、それを最終の結果にする
            if (this._interimText.trim() !== "") {
                this._settle("result", {text: this._interimText});
            } else {
                this._settle("nomatch");
            }
            this._dispose();
            if (! this._ended) {
                this._ended = true;
                this._emit("end");
            }
        };
        this._recognition = recognition;
    }

    /**
     * 認識を始める。
     * @param {Float32Array} preroll 発話と決まった時点までの音（少し前から）
     */
    start(preroll) {
        this.push(preroll);
        this._recognition.start(this._track);
    }

    /** 続きの音を流す。 */
    push(samples) {
        if (! this._ended) {
            this._player.port.postMessage(samples, [samples.buffer]);
        }
    }

    /** 発話が終わった。確定を待ち、一定時間たっても終わらなければ打ち切る。 */
    finish() {
        if (this._ended || this._timer !== null) {
            return;
        }
        this._timer = setTimeout(() => {
            this._recognition.abort(); // onend で、途中の結果を最終の結果にする
        }, FINALIZE_TIMEOUT_MS);
    }

    /** すぐに打ち切る。結末は知らせない（取りやめたのはこちらの都合なので）。 */
    abort() {
        this._settled = true;
        try {
            this._recognition.abort();
        } catch (error) {
            // すでに終わっている
        }
        this._dispose();
    }

    /** 結末を知らせる（一度だけ）。 */
    _settle(type, detail = null) {
        if (this._settled) {
            return;
        }
        this._settled = true;
        this._emit(type, detail);
    }

    _dispose() {
        clearTimeout(this._timer);
        this._player.port.postMessage("dispose");
        this._player.disconnect();
        this._track.stop();
    }

    _emit(type, detail = null) {
        this.dispatchEvent(new CustomEvent(type, {detail}));
    }
}
