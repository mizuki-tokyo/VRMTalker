/**
 * メインスレッドから受け取った音を、順に流す AudioWorklet。
 *
 * 出力は MediaStreamAudioDestinationNode につなぎ、そのトラックを
 * SpeechRecognition.start(track) に渡す。
 *
 * 流す音が無い間も、無音を出し続ける（出力は 0 で始まるので、何も書かなければ
 * 無音になる）。音声認識は、話し終えた後の無音を聞いて結果を確定するので、
 * 無音が届かないといつまでも確定しない（Chrome・Edge で確かめた）。
 *
 * メッセージ
 *   受け取る  Float32Array   流す音（順に足していく）
 *   受け取る  "dispose"      止める
 */
class PlayerProcessor extends AudioWorkletProcessor {

    constructor() {
        super();
        this.queue = [];
        this.readOffset = 0;
        this.alive = true;

        this.port.onmessage = ({data}) => {
            if (data === "dispose") {
                this.alive = false;
            } else {
                this.queue.push(data);
            }
        };
    }

    process(inputs, outputs) {
        const out = outputs[0][0];
        let written = 0;
        while (written < out.length && this.queue.length > 0) {
            const head = this.queue[0];
            const n = Math.min(out.length - written, head.length - this.readOffset);
            out.set(head.subarray(this.readOffset, this.readOffset + n), written);
            written += n;
            this.readOffset += n;
            if (this.readOffset >= head.length) {
                this.queue.shift();
                this.readOffset = 0;
            }
        }
        // 残りは無音のまま
        return this.alive;
    }
}

registerProcessor("speech-hands-free-player", PlayerProcessor);
