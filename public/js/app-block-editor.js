/**
 * ブロック編集画面。
 *
 * 画面を左右に分け、左でブロックを組みながら右で動きを確かめられるようにする。
 * 分割の本当の価値は画面の広さではなく、直したものをその場で試せること。
 * 保存すると、リロードせずに新しい動作へ差し替わる。
 *
 * Blockly（782KB）は、この画面を開いたときに初めて読み込む。対話するだけの
 * 利用者には不要なので、起動を重くしない。
 *
 * カスタム要素にしていないのは、Blockly が document 直下に注入する前提で
 * 作られており、Shadow DOM の中では座標計算やスタイルが崩れるため。
 * この画面だけは light DOM で扱う。
 */

import {defineBlocks, createToolbox} from "./app-blocks.js";

const BLOCKLY_VERSION = "13.2.1";
const BLOCKLY_SCRIPTS = [
    `https://cdn.jsdelivr.net/npm/blockly@${BLOCKLY_VERSION}/blockly.min.js`,
    `https://cdn.jsdelivr.net/npm/blockly@${BLOCKLY_VERSION}/msg/ja.js`
];

/** 分割の幅。CSS の --editor-width に入れる */
const MIN_WIDTH = 280;
const DEFAULT_WIDTH_RATIO = 0.5;

/** この幅より狭い画面では全画面にする（スマートフォン） */
const FULLSCREEN_MAX_WIDTH = 820;

const STORAGE_KEY = "vrmtalker.editorWidth";


/** UMD の Blockly を順に読み込む。二度目以降は何もしない。 */
const loadBlockly = (() => {
    let loading = null;
    return () => {
        if (loading) {
            return loading;
        }
        loading = BLOCKLY_SCRIPTS.reduce((chain, src) => chain.then(() => new Promise(
            (resolve, reject) => {
                const script = document.createElement("script");
                script.src = src;
                script.onload = () => resolve();
                script.onerror = () => reject(new Error(`${src} を読み込めませんでした`));
                document.head.appendChild(script);
            })), Promise.resolve()).then(() => window.Blockly);
        return loading;
    };
})();


/** Scratch 風のテーマ。Zelos を base に色だけ差し替える。 */
const createTheme = (Blockly) => {
    const PALETTE = {
        motion: "#4C97FF", looks: "#9966FF", sound: "#CF63CF", events: "#FFBF00",
        control: "#FFAB19", sensing: "#5CB1D6", operators: "#59C059", variables: "#FF8C1A"
    };
    const darken = (hex, ratio) => {
        const n = parseInt(hex.slice(1), 16);
        const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
              .map((v) => Math.round(v * (1 - ratio)));
        return "#" + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1);
    };
    const style = (colour, extra) => ({
        colourPrimary: colour,
        colourSecondary: darken(colour, 0.1),
        colourTertiary: darken(colour, 0.2),
        ...extra
    });

    return Blockly.Theme.defineTheme("vrmtalker", {
        base: Blockly.Themes.Zelos,
        blockStyles: {
            // hat:"cap" で「〜のとき」が帽子型になる
            event_blocks: style(PALETTE.events, {hat: "cap"}),
            control_blocks: style(PALETTE.control),
            motion_blocks: style(PALETTE.motion),
            looks_blocks: style(PALETTE.looks),
            sound_blocks: style(PALETTE.sound),
            sensing_blocks: style(PALETTE.sensing),
            operator_blocks: style(PALETTE.operators),
            variable_blocks: style(PALETTE.variables),
            math_blocks: style(PALETTE.operators),
            text_blocks: style(PALETTE.operators),
            logic_blocks: style(PALETTE.operators),
            loop_blocks: style(PALETTE.control),
            list_blocks: style(PALETTE.variables),
            procedure_blocks: style("#FF6680")
        },
        categoryStyles: {
            event_category: {colour: PALETTE.events},
            control_category: {colour: PALETTE.control},
            looks_category: {colour: PALETTE.looks},
            sensing_category: {colour: PALETTE.sensing},
            operator_category: {colour: PALETTE.operators},
            variable_category: {colour: PALETTE.variables}
        },
        componentStyles: {
            workspaceBackgroundColour: "#F9F9F9",
            toolboxBackgroundColour: "#FFFFFF",
            toolboxForegroundColour: "#575E75",
            flyoutBackgroundColour: "#F9F9F9",
            flyoutForegroundColour: "#575E75",
            flyoutOpacity: 0.9,
            scrollbarColour: "#CECDCE",
            insertionMarkerColour: "#000000",
            insertionMarkerOpacity: 0.2
        },
        fontStyle: {
            family: '"LINESeedJP_Rg", "Hiragino Sans", "Noto Sans JP", sans-serif',
            weight: "bold",
            size: 12
        },
        // 帽子が付くのはイベントブロックだけにする
        startHats: false
    });
};


/** 登録したレンダラーの名前。inject の renderer に渡す。 */
const RENDERER_NAME = "vrmtalker-zelos";

let rendererRegistered = false;

/**
 * Zelos を土台に、C 型ブロックの左の縦棒を細くしたレンダラーを登録する。
 *
 * 「もし〜なら」「くりかえす」「ずっと」の左の棒は、Zelos の既定だと太く、
 * Scratch に慣れた目には不恰好に映る。
 *
 * 寸法を持っているのは ConstantProvider なので、それを継承して数値を
 * 上書きし、上書きした側を返す Renderer を登録する。登録は一度きりで、
 * 二度目は Blockly が例外を投げる
 */
const registerRenderer = (Blockly) => {
    if (rendererRegistered) {
        return RENDERER_NAME;
    }

    class ScratchLikeConstantProvider extends Blockly.zelos.ConstantProvider {
        constructor() {
            super();
            // 内側の開始位置は NOTCH_OFFSET_LEFT(12) + この値になる。
            // Zelos の既定は 16（合計 28px）で、Scratch はもっと細い
            this.STATEMENT_INPUT_PADDING_LEFT = 4;
        }
    }

    class ScratchLikeRenderer extends Blockly.zelos.Renderer {
        makeConstants_() {
            return new ScratchLikeConstantProvider();
        }
    }

    Blockly.blockRendering.register(RENDERER_NAME, ScratchLikeRenderer);
    rendererRegistered = true;
    return RENDERER_NAME;
};


/**
 * @param {object} deps
 * @param {string} deps.actionsUrl 定義の読み込み元
 * @param {() => {motionNames: string[], emoteNames: string[]}} deps.getNames
 *        ドロップダウンに出す名前。編集画面を開いた時点で読み直す
 * @param {(program: object) => Promise<void>} deps.onSave 保存できたとき
 */
const createBlockEditor = ({actionsUrl, getNames, onSave}) => {

    const root = document.querySelector("#block-editor");
    const area = root.querySelector("#blockly-area");
    const statusElement = root.querySelector("#editor-status");

    let workspace = null;
    let dirty = false;
    let resizeObserver = null;

    const isFullscreen = () => window.innerWidth <= FULLSCREEN_MAX_WIDTH;

    const setStatus = (message, isError = false) => {
        statusElement.textContent = message;
        statusElement.classList.toggle("is-error", isError);
    };

    //---------------------------------- 分割幅

    const readStoredWidth = () => {
        try {
            return Number(localStorage.getItem(STORAGE_KEY)) || 0;
        } catch (error) {
            return 0;
        }
    };

    const applyWidth = (width) => {
        if (isFullscreen()) {
            document.documentElement.style.removeProperty("--editor-width");
            return;
        }
        // 右側（アバター）が潰れないよう、両端に余地を残す
        const max = Math.max(MIN_WIDTH, window.innerWidth - MIN_WIDTH);
        const applied = Math.min(Math.max(width, MIN_WIDTH), max);
        document.documentElement.style.setProperty("--editor-width", `${applied}px`);
        try {
            localStorage.setItem(STORAGE_KEY, String(applied));
        } catch (error) {
            // 保存できなくても分割自体は動く
        }
    };

    /** 仕切りをドラッグして幅を変える。 */
    const setupSplitter = () => {
        const splitter = root.querySelector("#editor-splitter");
        splitter.addEventListener("pointerdown", (event) => {
            if (isFullscreen()) {
                return;
            }
            splitter.setPointerCapture(event.pointerId);
            const onMove = (moveEvent) => applyWidth(moveEvent.clientX);
            const onUp = () => {
                splitter.removeEventListener("pointermove", onMove);
                splitter.removeEventListener("pointerup", onUp);
            };
            splitter.addEventListener("pointermove", onMove);
            splitter.addEventListener("pointerup", onUp, {once: true});
        });
    };

    //---------------------------------- 読み書き

    const loadProgram = async () => {
        try {
            const response = await fetch(actionsUrl);
            if (! response.ok) {
                throw new Error(`${response.status}`);
            }
            Blockly.serialization.workspaces.load(await response.json(), workspace);
            setStatus("読み込みました");
        } catch (error) {
            console.warn(`${actionsUrl} を読み込めませんでした`, error);
            setStatus("定義がありません。ブロックを組んで保存してください");
        }
        dirty = false;
    };

    const save = async () => {
        const program = Blockly.serialization.workspaces.save(workspace);
        setStatus("保存しています…");
        try {
            const response = await fetch("/api/actions", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(program)
            });
            if (! response.ok) {
                const detail = await response.json().catch(() => null);
                throw new Error(detail?.detail || `${response.status}`);
            }
        } catch (error) {
            console.error(error);
            setStatus(`保存できませんでした: ${error.message}`, true);
            return;
        }
        dirty = false;
        // リロードせずに新しい動作へ差し替える。これが分割表示の主目的
        await onSave(program);
        setStatus("保存しました。すぐ試せます");
    };

    //---------------------------------- 開閉

    const build = async () => {
        const Blockly = await loadBlockly();
        if (! Blockly) {
            throw new Error("Blockly を読み込めませんでした");
        }
        for (const warning of defineBlocks(Blockly, getNames())) {
            console.warn(`ブロック定義: ${warning}`);
        }

        workspace = Blockly.inject(area, {
            toolbox: createToolbox(),
            theme: createTheme(Blockly),
            renderer: registerRenderer(Blockly),
            // カテゴリ付きにするとパレットが開きっぱなしになり、Scratch に近くなる
            horizontalLayout: false,
            trashcan: true,
            zoom: {controls: true, wheel: true, startScale: 0.8},
            move: {scrollbars: true, drag: true, wheel: true}
        });

        workspace.addChangeListener((event) => {
            if (! event.isUiEvent) {
                dirty = true;
            }
        });

        // 幅が変わるたびに呼ばないと Blockly の描画が崩れる
        resizeObserver = new ResizeObserver(() => Blockly.svgResize(workspace));
        resizeObserver.observe(area);

        await loadProgram();
    };

    const open = async () => {
        if (root.hasAttribute("open")) {
            return;
        }
        root.setAttribute("open", "");
        applyWidth(readStoredWidth() || window.innerWidth * DEFAULT_WIDTH_RATIO);

        if (! workspace) {
            setStatus("読み込んでいます…");
            try {
                await build();
            } catch (error) {
                console.error(error);
                setStatus(error.message, true);
                return;
            }
        }
        Blockly.svgResize(workspace);
    };

    const close = () => {
        if (dirty && ! window.confirm("保存していない変更があります。閉じますか？")) {
            return;
        }
        root.removeAttribute("open");
        document.documentElement.style.removeProperty("--editor-width");
    };

    //---------------------------------- 組み立て

    root.querySelector("#editor-save").addEventListener("click", save);
    root.querySelector("#editor-close").addEventListener("click", close);
    setupSplitter();

    window.addEventListener("resize", () => {
        if (root.hasAttribute("open")) {
            applyWidth(readStoredWidth() || window.innerWidth * DEFAULT_WIDTH_RATIO);
        }
    });

    return {
        open,
        close,
        toggle: () => (root.hasAttribute("open") ? close() : open()),
        get isOpen() { return root.hasAttribute("open"); }
    };
};

export default createBlockEditor;
