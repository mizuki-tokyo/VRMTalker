const TRANSITION_SEC = 0.3;

/**
 * 位置に応じてToastのスタイルを設定
 * @private
 * @param {HTMLElement} toast - Toast要素
 * @param {string} position - 表示位置
 */
const _setPosition = (toast, position) => {
    switch (position) {
	case "top-left": // 画面左上
            toast.style.top = "16px";
            toast.style.left = "16px";
	    break;
        case "top-center": // 画面中央上側
	    toast.style.top = "16px";
	    toast.style.left = "50%";
            toast.style.transform = "translateX(-50%)";
            break;
	case "top-right": // 画面右上
	    toast.style.top = "16px";
	    toast.style.right = "16px";
	    break;
        case "center": // 画面中央
            toast.style.top = "50%";
            toast.style.left = "50%";
            toast.style.transform = "translate(-50%, -50%)";
            break;
        case "bottom-left": // 画面左下
            toast.style.bottom = "16px";
            toast.style.left = "16px";
            break;
	case "bottom-center": // 画面中央下側（デフォルト）
	default:
            toast.style.bottom = "16px";
            toast.style.left = "50%";
            toast.style.transform = "translateX(-50%)";
            break;
        case "bottom-right": // 画面右下
            toast.style.bottom = "16px";
            toast.style.right = "16px";
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
     * Toastを表示する
     * @param {string} message - 表示するメッセージ
     * @param {number} duration - 表示時間（ミリ秒）
     * @param {string} position - 表示位置（'bottom-right', 'center', 'bottom-center'）
     */
    show: (message, duration = 2000, position = 'bottom-center') => {
        const toast = document.createElement("div");
        toast.textContent = message;
        toast.style.backgroundColor = "#3338";
        toast.style.color = "#fff";
        toast.style.borderRadius = "6px";
        toast.style.padding = "16px";
        toast.style.position = "fixed";
        toast.style.opacity = "0";
        toast.style.transition = `opacity ${TRANSITION_SEC}s ease-in-out`;
        toast.style.zIndex = "9999";

        // 位置によってスタイルを設定
        _setPosition(toast, position);

        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = "1";
            setTimeout(() => {
                toast.style.opacity = "0";
                setTimeout(() => {
                    document.body.removeChild(toast);
                }, TRANSITION_SEC * 1000);
            }, duration);
        }, 0);
    }
});

export default Toast;

// 使用例：
// Toast.show("メッセージ");  // デフォルト（中央下）
// Toast.show("メッセージ", 3000, Toast.POSITION.CENTER);  // 中央
