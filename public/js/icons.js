/**
 * アプリの中で使い回すアイコン（icons/icon-list.svg の <symbol>）を、要素として作る。
 *
 *   element.append(createIcon("triangle-alert"));
 *
 * アイコンの置き場所の決め方
 *   - ほかのアプリでも使える部品（web-ui/dialog.js など）は、持ち運べるよう
 *     ソースの中に埋め込む
 *   - このアプリだけのソースで、1 か所でしか使わないものも、埋め込んでよい
 *   - それ以外（複数の箇所で使い回すもの）は icon-list.svg に <symbol> として
 *     定義し、ここから使う
 *
 * 線の色は文字の色（currentColor）に従う。大きさは CSS で決める（class="icon"）。
 */

const ICON_LIST_URL = new URL("../icons/icon-list.svg", import.meta.url).href;

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @param {string} id icon-list.svg の <symbol> の id
 * @returns {SVGSVGElement}
 */
export const createIcon = (id) => {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", `${ICON_LIST_URL}#${id}`);
    svg.append(use);
    return svg;
};
