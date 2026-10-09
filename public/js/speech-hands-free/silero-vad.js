/**
 * 発話検出（Silero VAD v5）を、onnxruntime-web で動かす。
 *
 *   const vad = await SileroVAD.create();
 *   const probability = await vad.process(frame);   // 512 サンプル → 0〜1
 *
 * どちらも public/vendor/ に置いてある（scripts/setup_vendor.py で取得する）。
 * 版を上げるときは、あちらとここの両方を書き換える。
 *
 * モデルの入出力（16 kHz のとき）
 *   input  float32 [1, 64 + 512]  直前のかたまりの末尾 64 サンプル ＋ 今回の 512 サンプル
 *   state  float32 [2, 1, 128]    前回から引き継ぐ内部の状態
 *   sr     int64                  サンプルレート（16000）
 *   output float32 [1, 1]         発話らしさ（0〜1）
 *   stateN float32 [2, 1, 128]    次回へ引き継ぐ内部の状態
 */
import * as ort from "../../vendor/onnxruntime-web@1.22.0/dist/ort.wasm.min.mjs";

const ORT_DIR = new URL("../../vendor/onnxruntime-web@1.22.0/dist/", import.meta.url);
const MODEL_URL = new URL(
    "../../vendor/silero-vad@5.1.2/src/silero_vad/data/silero_vad.onnx", import.meta.url);

export const SAMPLE_RATE = 16000;
export const FRAME_SIZE = 512; // 32 ミリ秒
const CONTEXT_SIZE = 64;
const STATE_SIZE = 2 * 1 * 128;

// WebAssembly の置き場所。既定では CDN から読もうとする
ort.env.wasm.wasmPaths = ORT_DIR.href;
// 1 スレッドで動かす。複数スレッドには SharedArrayBuffer が要り、そのためには
// サーバーに特別なヘッダー（cross-origin isolation）が要る。32 ミリ秒ごとに
// 1 回の推論なので、1 スレッドで十分に間に合う
ort.env.wasm.numThreads = 1;

export default class SileroVAD {

    static async create() {
        const session = await ort.InferenceSession.create(MODEL_URL.href, {
            executionProviders: ["wasm"]
        });
        return new SileroVAD(session);
    }

    constructor(session) {
        this.session = session;
        this.sampleRate = new ort.Tensor("int64", BigInt64Array.from([BigInt(SAMPLE_RATE)]));
        this.input = new Float32Array(CONTEXT_SIZE + FRAME_SIZE);
        this.reset();
    }

    /** 内部の状態を初めに戻す（聞き始めるときに呼ぶ）。 */
    reset() {
        this.state = new Float32Array(STATE_SIZE);
        this.context = new Float32Array(CONTEXT_SIZE);
    }

    /**
     * 512 サンプルのかたまりを 1 つ調べ、発話らしさ（0〜1）を返す。
     * @param {Float32Array} frame
     * @returns {Promise<number>}
     */
    async process(frame) {
        if (frame.length !== FRAME_SIZE) {
            throw new Error(`かたまりの長さは ${FRAME_SIZE} サンプルにすること（${frame.length}）`);
        }
        this.input.set(this.context, 0);
        this.input.set(frame, CONTEXT_SIZE);

        const output = await this.session.run({
            input: new ort.Tensor("float32", this.input.slice(), [1, CONTEXT_SIZE + FRAME_SIZE]),
            state: new ort.Tensor("float32", this.state, [2, 1, 128]),
            sr: this.sampleRate
        });

        this.state = new Float32Array(output.stateN.data);
        this.context = frame.slice(FRAME_SIZE - CONTEXT_SIZE);
        return output.output.data[0];
    }
}
