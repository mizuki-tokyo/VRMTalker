/**
 * 返事の感情。
 *
 * LLM には、返事の最初に気持ちを表す絵文字を 1 つ付けてもらっている
 * （src/llm/__init__.py の EMOTION_ESTIMATION）。ここでは、その絵文字を
 * 読み取って 5 つの感情のどれかにし、読み上げや表示のために絵文字を取り除く。
 *
 *   readEmotion("😢 それはさびしいね。")   // "sad"
 *   stripEmoji("😢 それはさびしいね。")    // "それはさびしいね。"
 *
 * 小さなモデル（同梱の LFM2.5-2.6B）は、決めた 5 つではなく似た絵文字
 * （😊 など）を選んだり、ほかの絵文字をあちこちに付けたりする。そこで
 * 似た絵文字は 5 つのどれかに寄せ、返事の中で最初に見つかったものを
 * その返事の感情とする。
 *
 * 感情の id は、表情の名前（happy など。VRM の基本表情）と同じにしてある。
 */

/**
 * 感情の一覧。並びはブロックのドロップダウンの順になる。
 * name は、表情のブロックの選択肢（app-blocks.js の EXPRESSIONS）とそろえる
 */
export const EMOTIONS = Object.freeze([
    {id: "happy", emoji: "😄", name: "うれしい"},
    {id: "angry", emoji: "😠", name: "おこり"},
    {id: "sad", emoji: "😢", name: "かなしい"},
    {id: "surprised", emoji: "😮", name: "おどろき"},
    {id: "relaxed", emoji: "😌", name: "リラックス"}
]);

/**
 * 似た絵文字を、どの感情として読むか。
 *
 * 😊 は、ふつうの返事や落ち着いた返事にもよく選ばれるが、うれしいとして読む
 * （取りこぼすよりは、と決めた）。ここに無い絵文字（👍 など）は感情として
 * 読まない
 */
const SIMILAR_EMOJI = {
    happy: "😄😊😃😁😆😂🤣🥰😍🤩🤗😺🎉🥳",
    angry: "😠😡🤬😤💢👿",
    sad: "😢😭😔😞😟🥺😿💔😥😓",
    surprised: "😮😲😯😳🤯😱🙀",
    relaxed: "😌😇☺"
};

const EMOTION_OF_EMOJI = new Map(
    Object.entries(SIMILAR_EMOJI).flatMap(([id, emojis]) =>
        [...emojis].map((emoji) => [emoji, id])));

/**
 * 絵文字 1 つぶん（肌の色や、ZWJ でつないだ組み合わせも含む）。
 *
 * ♪ ♡ ☆ は絵文字ではないので対象外。© ® ‼ は絵文字の扱いだが、文章の記号と
 * して使われるので U+2600 より前は残す（stripEmoji を参照）
 */
const EMOJI_PATTERN =
      /\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic})*️?/gu;

// 取り除くときは、後ろの空白も一緒に（「😢 それは」→「それは」）
const EMOJI_WITH_SPACE_PATTERN = new RegExp(`${EMOJI_PATTERN.source}[ \\u3000]*`, "gu");

const isTextSymbol = (emoji) => emoji.codePointAt(0) < 0x2600;

/**
 * 返事（または 1 文）の感情を読み取る。
 * @param {string} text
 * @returns {string|null} EMOTIONS の id。見つからなければ null
 */
export const readEmotion = (text) => {
    for (const [emoji] of String(text).matchAll(EMOJI_PATTERN)) {
        // 異体字セレクタ（U+FE0F）を外して引く（☺️ と ☺ を同じに扱う）
        const id = EMOTION_OF_EMOJI.get(emoji.replace(/️/g, ""));
        if (id) {
            return id;
        }
    }
    return null;
};

/**
 * 絵文字を取り除く。読み上げと表示に使う。
 * @param {string} text
 * @returns {string}
 */
export const stripEmoji = (text) => String(text)
    .replace(EMOJI_WITH_SPACE_PATTERN, (emoji) => isTextSymbol(emoji) ? emoji : "")
    .trim();

/**
 * 感情の絵文字。
 * @param {string} id EMOTIONS の id
 * @returns {string} 知らない id なら空文字
 */
export const emotionEmoji = (id) => EMOTIONS.find((emotion) => emotion.id === id)?.emoji ?? "";
