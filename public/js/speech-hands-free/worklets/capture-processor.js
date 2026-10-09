/**
 * マイクの音を、決まった長さ（既定 512 サンプル）のかたまりにまとめて
 * メインスレッドへ送る AudioWorklet。
 *
 * 16 kHz の AudioContext で使う。512 サンプルは 32 ミリ秒で、発話検出
 * （Silero VAD）が 1 回に受け取る長さと同じ。
 */
class CaptureProcessor extends AudioWorkletProcessor {

    constructor(options) {
        super();
        this.frameSize = options.processorOptions?.frameSize ?? 512;
        this.frame = new Float32Array(this.frameSize);
        this.offset = 0;
    }

    process(inputs) {
        const channel = inputs[0]?.[0];
        if (! channel) {
            return true;
        }
        let i = 0;
        while (i < channel.length) {
            const n = Math.min(channel.length - i, this.frameSize - this.offset);
            this.frame.set(channel.subarray(i, i + n), this.offset);
            this.offset += n;
            i += n;
            if (this.offset === this.frameSize) {
                // 中身ごと渡して（transfer）、写す手間を省く
                this.port.postMessage(this.frame, [this.frame.buffer]);
                this.frame = new Float32Array(this.frameSize);
                this.offset = 0;
            }
        }
        return true;
    }
}

registerProcessor("speech-hands-free-capture", CaptureProcessor);
