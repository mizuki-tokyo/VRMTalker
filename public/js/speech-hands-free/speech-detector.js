/**
 * 発話らしさ（Silero VAD）から、発話の始まりと終わりを判定する。
 *
 *   待機 ─(発話らしい)─▶ 候補 ─(発話らしいのが minSpeechFrames 回)─▶ 発話中
 *    ▲                    │                                            │
 *    └─(発話らしくないのが redemptionFrames 回続く：取り消し)─┘          │
 *    └──────────────(発話らしくないのが redemptionFrames 回続く：終わり)─┘
 *
 * 発話と決まったら、候補になった位置の preSpeechPadFrames 前から今までの音を
 * リングバッファから取り出して speechstart で知らせる（話し始めが欠けないように）。
 *
 * 判定を止めている間（detecting が false）も、音はリングバッファに溜め続ける。
 * アバターが話している間などは判定しない（アバターの声を拾わないように）が、
 * 判定を再開したときに、すぐ前の音までさかのぼれるようにするため。
 *
 * イベント
 *   probability  {probability, speaking}  かたまりごとの発話らしさ
 *   speechstart  {audio}                  発話と決まった。audio は少し前からの音
 *   speechframe  {frame}                  発話中に届いた続きの音
 *   speechend                             発話が終わった
 */
export default class SpeechDetector extends EventTarget {

    /**
     * @param {object} vad      process(frame) で発話らしさを返すもの（SileroVAD）
     * @param {object} ring     RingBuffer
     * @param {object} [options]
     */
    constructor(vad, ring, options = {}) {
        super();
        this.vad = vad;
        this.ring = ring;
        this.options = {
            frameSize: 512,
            positiveThreshold: 0.5,   // これ以上なら発話らしい
            negativeThreshold: 0.35,  // これ未満なら発話らしくない
            minSpeechFrames: 3,       // 約 96 ミリ秒続いたら発話と決める
            redemptionFrames: 22,     // 約 700 ミリ秒発話らしくなければ終わり
            preSpeechPadFrames: 10,   // 約 320 ミリ秒前からの音を渡す
            ...options
        };
        this.detecting = false;
        // 推論は非同期なので、かたまりを届いた順に処理するための鎖
        this.queue = Promise.resolve();
        this._resetState();
    }

    /**
     * 判定を始める・止める。止めると、発話の途中でも判定を初めに戻す。
     * 始めるときも、発話検出の内部の状態を初めに戻す。続けて調べていると、声に
     * よっては発話らしさが回を追って下がっていくため（Silero VAD そのものの性質で、
     * Python 版でも同じになる。音声合成の声で、0.93 → 0.27 → 0.13 のように）
     */
    setDetecting(detecting) {
        this.queue = this.queue.then(() => {
            this.detecting = detecting;
            this._resetState();
        });
    }

    /**
     * マイクのかたまりを 1 つ受け取る。リングバッファに溜め、判定中なら調べる。
     * リングバッファへの書き込みも推論と同じ順に行う（推論が遅れても、
     * 切り出したい区間が先に上書きされないように）
     *
     * @param {Float32Array} frame
     */
    pushFrame(frame) {
        this.queue = this.queue
            .then(() => this._process(frame))
            .catch((error) => console.error("発話の判定に失敗しました", error));
    }

    _resetState() {
        this.state = "idle";
        this.candidateStart = 0;
        this.positiveFrames = 0;
        this.negativeFrames = 0;
        this.vad.reset();
    }

    async _process(frame) {
        this.ring.push(frame);
        if (! this.detecting) {
            return;
        }
        const frameEnd = this.ring.totalWritten;
        const probability = await this.vad.process(frame);
        if (! this.detecting) {
            return; // 推論を待つ間に止められた
        }
        const o = this.options;
        const isPositive = probability >= o.positiveThreshold;
        const isNegative = probability < o.negativeThreshold;

        switch (this.state) {
        case "idle":
            if (isPositive) {
                this.state = "pending";
                this.candidateStart = frameEnd - o.frameSize;
                this.positiveFrames = 1;
                this.negativeFrames = 0;
            }
            break;

        case "pending":
            if (isPositive) {
                this.positiveFrames++;
                this.negativeFrames = 0;
            } else if (isNegative) {
                this.negativeFrames++;
            }
            if (this.negativeFrames >= o.redemptionFrames) {
                this.state = "idle";
            } else if (this.positiveFrames >= o.minSpeechFrames) {
                this.state = "speaking";
                this.negativeFrames = 0;
                const start = Math.max(
                    this.ring.oldest, this.candidateStart - o.preSpeechPadFrames * o.frameSize);
                this._emit("speechstart", {audio: this.ring.read(start, frameEnd)});
            }
            break;

        case "speaking":
            this._emit("speechframe", {frame});
            if (isPositive) {
                this.negativeFrames = 0;
            } else if (isNegative) {
                this.negativeFrames++;
            }
            if (this.negativeFrames >= o.redemptionFrames) {
                this.state = "idle";
                this._emit("speechend");
            }
            break;
        }

        this._emit("probability", {probability, speaking: this.state === "speaking"});
    }

    _emit(type, detail = null) {
        this.dispatchEvent(new CustomEvent(type, {detail}));
    }
}
