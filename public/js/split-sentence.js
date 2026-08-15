/**
 * 発話内容を一文ずつに分割する。
 *
 * LLM の応答をストリーミングで受けながら、文が完成した時点で音声合成へ
 * 回すために使う。区切り文字が見つからなかった残りは最後の要素として返るので、
 * 呼び出し側は「最後の要素はまだ未完成かもしれない」として扱える。
 */
const SENTENCE_DELIMITERS = [
    "。」", "。』", "!」", "!』","！」", "！』","?」", "?』","？」", "？』",
    "。", "！？", "！！", "？？", "？！", "？", "！", ". ", "!?", "!!", "??", "?!", "?", "!", "\n", "♪", "♡"
];

const splitSentence = (text) => {
    const result = [];
    let startIndex = 0;

    while (startIndex < text.length) {
        let minIndex = -1;
        let delimiter = '';
        for (const del of SENTENCE_DELIMITERS) {
            const index = text.indexOf(del, startIndex);
            if (index !== -1 && (minIndex === -1 || index < minIndex)) {
                minIndex = index;
                delimiter = del;
            }
        }
        if (minIndex !== -1) {
            // 区切り文字を含めて 1 文とする
            result.push(text.substring(startIndex, minIndex + delimiter.length));
            startIndex = minIndex + delimiter.length;
        } else {
            // 最後の部分を追加
            result.push(text.substring(startIndex));
            break;
        }
    }
    return result;
};

export default splitSentence;
