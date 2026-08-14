/**
 * 表情名を、そのモデルで実際に使える名前へ解決する。
 *
 * VRM 0.0 と VRM 1.0 ではプリセット表情の名前が異なる（Joy / happy など）が、
 * @pixiv/three-vrm の VRMExpressionLoaderPlugin が読み込み時に VRM 1.0 の名前へ
 * 変換するため、読み込み後のアプリ側は VRM 1.0 の名前だけを書けばよい。
 *
 *   VRM 0.0    VRM 1.0
 *   Joy     →  happy      Angry   →  angry
 *   Sorrow  →  sad        Fun     →  relaxed
 *   Neutral →  neutral    （驚 に相当するものは無い）
 *
 * ただし surprised だけは VRM 0.0 に対応するプリセットが無く、変換のしようがない。
 * VRM 0.0 のモデルでは単に存在しないので、代わりの表情に寄せる必要がある。
 *
 * また mouth-morph-mask.js が口マスク版の表情を作っている場合は、
 * 呼び出し側が "happy" と書いていても "happyNoMouth" を使う。
 */


/**
 * そのモデルに無かったときに代わりに使う表情。
 *
 * surprised は VRM 0.0 に存在しない。無反応になるよりはましなので近い表情へ
 * 寄せているが、用途に合わせて書き換えてよい。
 */
export const EXPRESSION_FALLBACKS = Object.freeze({
    surprised: Object.freeze(["happy", "neutral"])
});


/**
 * @param {VRMExpressionManager} expressionManager
 * @param {string} name 呼び出し側が指定した表情名
 * @param {Map<string, string>} [maskedNames] 元の表情名 → 口マスク版の表情名
 * @returns {string|null} このモデルで使える表情名。無ければ null
 */
const resolveExpressionName = (expressionManager, name, maskedNames) => {
    if (! expressionManager || ! name) {
        return null;
    }

    for (const candidate of [name, ...(EXPRESSION_FALLBACKS[name] || [])]) {
        // 口マスク版があるならそちらを優先する
        const masked = maskedNames?.get(candidate);
        if (masked && expressionManager.getExpression(masked)) {
            return masked;
        }
        if (expressionManager.getExpression(candidate)) {
            return candidate;
        }
    }
    return null;
};

export default resolveExpressionName;
