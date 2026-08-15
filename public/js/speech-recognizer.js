/**
 * 音声認識の抽象クラス。
 *
 * <speech-recognition> 要素にはこのクラスを継承したオブジェクトを注入する。
 * 認識方式を差し替えたいときは、このクラスを継承した実装を作って main.js で
 * 注入するものを変えればよい。要素側はこのファイルを import しないので、
 * 実装を増やしても UI には手を入れなくて済む。
 *
 *   class MyRecognizer extends SpeechRecognizer {
 *       start() { ... 認識を始め、結果が出たら this.onresult(text, isFinal) を呼ぶ ... }
 *       stop()  { ... }
 *   }
 *
 *   // main.js
 *   document.querySelector("speech-recognition").recognizer = new MyRecognizer();
 *
 * 実装が満たすべき約束
 *   - start() を呼ばれたら認識を始める
 *   - 確定前の結果も onresult(text, false) で流してよい
 *   - 確定したら onresult(text, true) を必ず一度呼ぶ
 *   - 入力レベルを取れるなら onvolumechange(0-100) で流す。取れなければ呼ばなくてよい
 *   - 認識が終わったら onvolumechange(0) を呼んでレベル表示を消す
 */

class SpeechRecognizer {

    /**
     * 認識結果。確定前は isFinal = false で何度も呼ばれる。
     * @type {(text: string, isFinal: boolean) => void}
     */
    onresult = (text, isFinal) => {};

    /**
     * 入力レベル。0-100。
     * @type {(level: number) => void}
     */
    onvolumechange = (level) => {};

    /** @type {(event: object) => void} */
    onerror = (event) => {};

    /** 認識はできたが結果を確定できなかったとき。 @type {(event: object) => void} */
    onnomatch = (event) => {};

    constructor() {
        if (new.target === SpeechRecognizer) {
            throw new Error(
                "SpeechRecognizer は抽象クラスです。継承した実装を生成してください。");
        }
    }

    /** 認識を開始する。 */
    start() {
        throw new Error(`${this.constructor.name}: start() が実装されていません。`);
    }

    /** 認識を停止する。 */
    stop() {
        throw new Error(`${this.constructor.name}: stop() が実装されていません。`);
    }
}

export default SpeechRecognizer;
