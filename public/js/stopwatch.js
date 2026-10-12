/**
 * ストップウォッチ。ブロックの「ストップウォッチを [開始▼] する」と
 * 「ストップウォッチの秒数」の値が使う。アプリ全体で 1 つ。
 *
 *   const stopwatch = new Stopwatch();
 *   stopwatch.start();
 *   stopwatch.seconds;   // → 2.3（0.1 秒単位、切り捨て）
 *
 * 動きは本物のストップウォッチに合わせてある。
 *
 *   開始      止まっていれば、今の値から続きを数える（動いていれば何もしない）
 *   停止      動いていれば、その値で止める
 *   リセット  0 に戻す。動いていれば 0 から数え続け、止まっていれば止まったまま
 *
 * 「前回の発話からどれくらい空いたか」は、一度開始しておき、発話のたびに
 * 値を読んでからリセットすれば分かる。
 *
 * 時間を数えるために一定間隔で動く処理は持たない。開始した時刻と、それまでに
 * たまった時間だけを覚えておき、読まれたときに計算する。時刻は
 * performance.now() で測る（パソコンの時計を合わせ直しても、画面が隠れて
 * いても、正しく進む）
 */
export default class Stopwatch {

    /** 前に止めるまでにたまった時間（ミリ秒）。 */
    _accumulated = 0;

    /** 動き始めた時刻（performance.now()）。止まっていれば null。 */
    _startedAt = null;

    /** 動いているか。 */
    get running() {
        return this._startedAt !== null;
    }

    /** 経過時間（秒）。0.1 秒単位に切り捨てる。 */
    get seconds() {
        const running = this.running ? performance.now() - this._startedAt : 0;
        return Math.floor((this._accumulated + running) / 100) / 10;
    }

    start() {
        if (! this.running) {
            this._startedAt = performance.now();
        }
    }

    stop() {
        if (this.running) {
            this._accumulated += performance.now() - this._startedAt;
            this._startedAt = null;
        }
    }

    reset() {
        this._accumulated = 0;
        if (this.running) {
            this._startedAt = performance.now();
        }
    }
}
