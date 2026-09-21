/**
 * 画面に短いメッセージを重ねて出す（トースト）。
 *
 *   Toast.show("保存しました");
 *   Toast.show("エラーが起きました", 3000, Toast.POSITION.CENTER);
 *
 * 押せない・待たせない知らせに使う。返事を求めるならダイアログ（dialog.js）を
 * 使うこと。
 *
 * このファイルはプロジェクトに依存しない。色や角の丸みは、置いた先から
 * カスタムプロパティで変えられる（既定値だけでも成立する）。
 *
 *   --toast-surface  下地の色
 *   --toast-ink      文字色
 *   --toast-radius   角の丸み
 */

const TRANSITION_SEC = 0.3;

/** 出ているトースト。次を出すときに消す（重なると両方読めなくなる） */
let current = null;

/**
 * 位置に応じて Toast のスタイルを設定
 * @private
 * @param {HTMLElement} toast - Toast要素
 * @param {string} position - 表示位置
 */
const _setPosition = (toast, position) => {
    // 画面端の余白（iPhone のノッチ等）。指定が無ければ 0
    const top = "max(16px, env(safe-area-inset-top, 0px))";
    const bottom = "max(16px, env(safe-area-inset-bottom, 0px))";
    const left = "max(16px, env(safe-area-inset-left, 0px))";
    const right = "max(16px, env(safe-area-inset-right, 0px))";

    switch (position) {
    case "top-left": // 画面左上
        toast.style.top = top;
        toast.style.left = left;
        break;
    case "top-center": // 画面中央上側
        toast.style.top = top;
        toast.style.left = "50%";
        toast.style.transform = "translateX(-50%)";
        break;
    case "top-right": // 画面右上
        toast.style.top = top;
        toast.style.right = right;
        break;
    case "center": // 画面中央
        toast.style.top = "50%";
        toast.style.left = "50%";
        toast.style.transform = "translate(-50%, -50%)";
        break;
    case "bottom-left": // 画面左下
        toast.style.bottom = bottom;
        toast.style.left = left;
        break;
    case "bottom-center": // 画面中央下側（デフォルト）
    default:
        toast.style.bottom = bottom;
        toast.style.left = "50%";
        toast.style.transform = "translateX(-50%)";
        break;
    case "bottom-right": // 画面右下
        toast.style.bottom = bottom;
        toast.style.right = right;
        break;
    }
};


const Toast = Object.freeze({
    // 位置の定数
    POSITION: Object.freeze({
        TOP_LEFT: 'top-left',
        TOP_CENTER: 'top-center',
        TOP_RIGHT: 'top-right',
        CENTER: 'center',
        BOTTOM_LEFT: 'bottom-left',
        BOTTOM_CENTER: 'bottom-center',
        BOTTOM_RIGHT: 'bottom-right'
    }),

    /**
     * Toast を表示する。
     *
     * 出ているものがあれば消してから出す。重ねると文字が重なって
     * どちらも読めなくなるため、最後に言われたものだけを見せる。
     *
     * @param {string} message - 表示するメッセージ
     * @param {number} duration - 表示時間（ミリ秒）
     * @param {string} position - 表示位置（POSITION の値）
     * @param {Element} parent - 出す先。既定は <body>。
     *                           position:fixed は、transform 等が掛かった
     *                           祖先があるとその中で位置が決まるので、
     *                           画面の一部に収めたいときはそこを渡す
     */
    show: (message, duration = 2000, position = 'bottom-center',
           parent = document.body) => {
        Toast.dismiss();

        const toast = document.createElement("div");
        toast.textContent = message;
        toast.style.position = "fixed";
        toast.style.zIndex = "9999";
        toast.style.padding = "16px";
        toast.style.borderRadius = "var(--toast-radius, 6px)";
        toast.style.background = "var(--toast-surface, #3338)";
        toast.style.color = "var(--toast-ink, #fff)";
        // 長い文でも画面からはみ出さないようにする（エラーの本文など）
        toast.style.maxWidth = "min(80%, 32em)";
        toast.style.overflowWrap = "anywhere";
        toast.style.whiteSpace = "pre-wrap";
        toast.style.textAlign = "center";
        // 読むだけのもの。下にあるものの操作を遮らない
        toast.style.pointerEvents = "none";
        toast.style.opacity = "0";
        toast.style.transition = `opacity ${TRANSITION_SEC}s ease-in-out`;

        // 位置によってスタイルを設定
        _setPosition(toast, position);

        parent.appendChild(toast);
        current = toast;

        const remove = () => {
            toast.remove();
            if (current === toast) {
                current = null;
            }
        };
        // 出した直後に透明度を変えて、変化として見せる
        setTimeout(() => {
            toast.style.opacity = "1";
            setTimeout(() => {
                toast.style.opacity = "0";
                setTimeout(remove, TRANSITION_SEC * 1000);
            }, duration);
        }, 0);
    },

    /** 出ているものを今すぐ消す。画面を切り替えるときなどに。 */
    dismiss: () => {
        current?.remove();
        current = null;
    }
});

export default Toast;

// 使用例：
// Toast.show("メッセージ");  // デフォルト（中央下）
// Toast.show("メッセージ", 3000, Toast.POSITION.CENTER);  // 中央
