/**
 * 直近の音を、決まった長さだけ溜めておく入れ物（リングバッファ）。
 *
 * 連続対話では、発話を見つけてから音声認識を始めるので、そのままでは
 * 話し始めが欠ける。マイクの音を常に溜めておき、見つけた時点から少し
 * さかのぼった音も一緒に渡すために使う。
 *
 * 位置は「これまでに書き込んだサンプルの通し番号」で表す。
 * 「発話が始まった位置の 320 ミリ秒前から今まで」のような切り出しが簡単にできる。
 */
export default class RingBuffer {

    /** @param {number} capacity 溜めておくサンプル数 */
    constructor(capacity) {
        this.capacity = capacity;
        this.buffer = new Float32Array(capacity);
        /** これまでに書き込んだサンプル数（＝次に書き込む位置の通し番号） */
        this.totalWritten = 0;
    }

    /** 残っている中で、いちばん古いサンプルの通し番号。 */
    get oldest() {
        return Math.max(0, this.totalWritten - this.capacity);
    }

    /** @param {Float32Array} samples */
    push(samples) {
        let source = samples;
        // 入れ物より長ければ、末尾だけを残す
        if (source.length > this.capacity) {
            this.totalWritten += source.length - this.capacity;
            source = source.subarray(source.length - this.capacity);
        }
        const position = this.totalWritten % this.capacity;
        const first = Math.min(source.length, this.capacity - position);
        this.buffer.set(source.subarray(0, first), position);
        if (first < source.length) {
            this.buffer.set(source.subarray(first), 0);
        }
        this.totalWritten += source.length;
    }

    /**
     * 通し番号で [from, to) の区間を写して返す。
     * すでに上書きされた部分は、残っている範囲に切り詰める。
     */
    read(from, to = this.totalWritten) {
        from = Math.max(from, this.oldest);
        to = Math.min(to, this.totalWritten);
        const length = Math.max(0, to - from);
        const out = new Float32Array(length);
        if (length === 0) {
            return out;
        }
        const position = from % this.capacity;
        const first = Math.min(length, this.capacity - position);
        out.set(this.buffer.subarray(position, position + first), 0);
        if (first < length) {
            out.set(this.buffer.subarray(0, length - first), first);
        }
        return out;
    }
}
