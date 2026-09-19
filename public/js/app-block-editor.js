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
import {createStackAction} from "./app-action-program.js";
import dialog from "./web-ui/dialog.js";

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

/**
 * この幅より狭いと、上のバーのモードの文字を畳んでアイコンだけにする。
 *
 * 画面の幅ではなく編集画面の幅で決める。利用者が横幅を変えられるので、
 * 広い画面でもバーが狭いことがある
 */
const NARROW_BAR_WIDTH = 560;

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
 * @param {object} deps.trial ブロックを試しに動かすための手立て（app.js が渡す）
 * @param {(key: string, action: (api) => Promise<void>) => Promise<void>} deps.trial.run
 * @param {(key: string) => boolean} deps.trial.isRunning
 * @param {(key: string) => void} deps.trial.stop
 * @param {(editing: boolean) => void} deps.trial.setEditing
 *        編集モードへ入る／出るとき。イベント実行の停止と再開は app.js 側が行う
 */
const createBlockEditor = ({actionsUrl, getNames, onSave, trial}) => {

    const root = document.querySelector("#block-editor");
    const area = root.querySelector("#blockly-area");
    const statusElement = root.querySelector("#editor-status");
    const modeGroup = root.querySelector("#editor-modes");
    const talkRadio = root.querySelector("#editor-mode-talk");
    const editRadio = root.querySelector("#editor-mode-edit");

    /** ラジオの選択を今のモードに合わせる。切り替えを断ったときにも戻す。 */
    const showMode = (isEditing) => {
        talkRadio.checked = ! isEditing;
        editRadio.checked = isEditing;
        root.classList.toggle("is-editing", isEditing);
    };

    let workspace = null;
    let dirty = false;
    let resizeObserver = null;

    // 編集モード（true）か会話モード（false）か。開いた直後は会話モードで、
    // ブロックを眺めながら実際の動きを確かめられる
    let editing = false;

    /** クリック実行の実行キー。ワークスペースをまたがないよう接頭辞を付ける */
    const trialKey = (blockId) => `trial:${blockId}`;

    const isFullscreen = () => window.innerWidth <= FULLSCREEN_MAX_WIDTH;

    const setStatus = (message, isError = false) => {
        statusElement.textContent = message;
        // 幅が足りないと末尾が「…」で切れる。全文はマウスを乗せれば読める
        statusElement.title = message;
        statusElement.classList.toggle("is-error", isError);
    };

    /** バーが狭いかどうかを CSS へ伝える。畳み方は index.html が決める。 */
    const updateBarLayout = () => {
        root.classList.toggle("is-narrow",
                              root.getBoundingClientRect().width < NARROW_BAR_WIDTH);
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

    //---------------------------------- 編集モードと会話モード

    /**
     * ハイライト。実行中のブロック列の根元に印を付ける。
     *
     * 印は根元のブロック 1 つだけで足りる。Blockly は連なるブロックを根元の
     * <g> の子孫として描くので、そこへ掛けたフィルタが列全体に及ぶ
     * （見た目の指定は index.html の .is-running を参照）。
     *
     * 消すときにブロックが既に削除されていることがあるので、都度たどり直さず
     * SVG を覚えておく
     */
    const highlighted = new Map();

    /**
     * 光の太さ。画面上で何ピクセルに見せたいか。
     *
     * フィルタのぼかし幅はブロックと同じ座標系で効くため、倍率をそのまま
     * 受ける。打ち消さないと、拡大したときに太く、縮小したときに消える。
     *
     * 拡大縮小に追従させるため viewport_change でも書き換えるが、光らせる
     * 瞬間にも入れ直す。倍率を変えただけでは viewport_change が出ないことが
     * あるため、始まりだけは確実に合わせておく
     */
    const GLOW_SIZE = 2;

    const updateGlowSize = (scale) => {
        area.style.setProperty("--glow-size", `${GLOW_SIZE / (scale || 1)}px`);
    };

    const setHighlight = (block, on) => {
        const key = block.id;
        if (on) {
            updateGlowSize(workspace.scale);
            const svg = block.getSvgRoot();
            svg.classList.add("is-running");
            highlighted.set(key, svg);
        } else {
            highlighted.get(key)?.classList.remove("is-running");
            highlighted.delete(key);
        }
    };

    const clearHighlights = () => {
        for (const svg of highlighted.values()) {
            svg.classList.remove("is-running");
        }
        highlighted.clear();
    };

    /** クリック実行が 1 つでも動いているか。会話モードへ移れるかの判定に使う。 */
    const isTrialRunning = () => [...highlighted.keys()]
          .some((id) => trial.isRunning(trialKey(id)));

    const stopAllTrials = () => {
        for (const id of [...highlighted.keys()]) {
            trial.stop(trialKey(id));
        }
        clearHighlights();
    };

    /**
     * ブロックをクリックしたとき。
     *
     * クリックされたブロックが属する列を根元からたどり、動いていなければ
     * 始め、動いていれば止める（Scratch と同じ）
     */
    const onBlockClick = async (blockId) => {
        const block = workspace.getBlockById(blockId);
        if (! block) {
            return;
        }
        const root = block.getRootBlock();
        const key = trialKey(root.id);

        if (trial.isRunning(key)) {
            trial.stop(key);
            return;
        }

        setHighlight(root, true);
        setStatus("試しに動かしています…");
        try {
            await trial.run(key, createStackAction(root));
        } finally {
            setHighlight(root, false);
            if (! isTrialRunning()) {
                setStatus("編集モードです。ブロックをクリックすると試せます");
            }
        }
    };

    /**
     * モードを切り替える。
     *
     * 会話モードでは Blockly を読み取り専用にする。これだけでブロックの移動も
     * 作成も止まり、しかもブロックのクリックが click イベントを出さなくなる
     * （targetType が "workspace" になる）ので、クリック実行も自動で無効になる。
     * ただしパレットは残ってしまうため、こちらで畳む
     */
    const setEditing = async (next) => {
        if (! workspace || next === editing) {
            return;
        }

        if (! next) {
            // 編集 → 会話。動かしたままにできない
            if (isTrialRunning()) {
                // 断ったので、ラジオの選択を今のモードへ戻す
                showMode(editing);
                setStatus("試し実行を止めてから会話モードへ切り替えてください", true);
                return;
            }
            // 画面のブロックと会話中の動きが食い違わないようにする
            if (dirty) {
                const willSave = await dialog.confirm(
                    "保存していない変更があります。\n"
                        + "保存してから会話モードへ移りますか？", {
                            title: "保存していない変更があります",
                            okText: "保存して移る",
                            cancelText: "変更を捨てる"
                        });
                if (willSave) {
                    await save();
                    if (dirty) {
                        showMode(editing);
                        return;   // 保存に失敗した
                    }
                } else {
                    await loadProgram();   // 保存済みの内容に戻す
                }
            }
        }

        editing = next;
        workspace.setIsReadOnly(! editing);
        showMode(editing);

        // 会話モードではパレットを畳む。読み取り専用でも開けてしまい、
        // 何も作れないので触った人が戸惑う
        const toolbox = workspace.getToolbox();
        if (! editing) {
            toolbox?.clearSelection();
        }

        trial.setEditing(editing);
        Blockly.svgResize(workspace);

        setStatus(editing
                  ? "編集モードです。ブロックをクリックすると試せます"
                  : "会話モードです。話しかけるとブロックが動きます");
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
            // 読み込みが済んだ合図。Blockly はイベントを非同期に配るので、
            // 定義を読み込んだ直後の create などは loadProgram() が
            // dirty を戻した「あと」に届く。放っておくと、何も編集して
            // いないのに未保存の扱いになる
            if (event.type === Blockly.Events.FINISHED_LOADING) {
                dirty = false;
                return;
            }
            if (! event.isUiEvent) {
                dirty = true;
            }
            // 会話モードでは読み取り専用なので、そもそもここへ来ない
            if (event.type === Blockly.Events.CLICK && event.targetType === "block") {
                onBlockClick(event.blockId);
            }
            // 拡大縮小しても光の太さが見かけ上変わらないようにする
            if (event.type === Blockly.Events.VIEWPORT_CHANGE) {
                updateGlowSize(event.scale ?? workspace.scale);
            }
        });

        // 幅が変わるたびに呼ばないと Blockly の描画が崩れる。
        // バーの畳み方も編集画面の幅で決まるので、ここで一緒に見る
        resizeObserver = new ResizeObserver(() => {
            Blockly.svgResize(workspace);
            updateBarLayout();
        });
        resizeObserver.observe(area);

        await loadProgram();

        // 開いた直後は会話モード。editing は false から始まるので、
        // 読み取り専用と表示をここで合わせておく
        workspace.setIsReadOnly(true);
        showMode(false);
        modeGroup.hidden = false;
    };

    const open = async () => {
        if (root.hasAttribute("open")) {
            return;
        }
        root.setAttribute("open", "");
        applyWidth(readStoredWidth() || window.innerWidth * DEFAULT_WIDTH_RATIO);
        updateBarLayout();

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

    const close = async () => {
        if (dirty && ! await dialog.confirm("保存していない変更があります。閉じますか？", {
            title: "保存していない変更があります",
            okText: "閉じる",
            cancelText: "やめる"
        })) {
            return;
        }
        // 閉じる＝会話モードへ戻る。試し実行を残したまま画面から消さない
        stopAllTrials();
        if (editing && workspace) {
            editing = false;
            workspace.setIsReadOnly(true);
            showMode(false);
            workspace.getToolbox()?.clearSelection();
            trial.setEditing(false);
        }
        root.removeAttribute("open");
        document.documentElement.style.removeProperty("--editor-width");
    };

    //---------------------------------- 組み立て

    root.querySelector("#editor-save").addEventListener("click", save);
    root.querySelector("#editor-close").addEventListener("click", close);
    // ラジオは選ばれた時点で見た目が変わる。切り替えを断る場合は
    // setEditing() の中で showMode() を呼んで選択を戻す
    talkRadio.addEventListener("change", () => setEditing(false));
    editRadio.addEventListener("change", () => setEditing(true));
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
