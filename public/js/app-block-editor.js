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
import dialog, {ICONS} from "./web-ui/dialog.js";

/*
  Blockly は public/vendor/ に置いてある（scripts/setup_vendor.py で取得する）。
  版を上げるときは、あちらとこちらの両方を書き換える
*/
const BLOCKLY_VERSION = "13.2.1";
const BLOCKLY_DIR = `./vendor/blockly@${BLOCKLY_VERSION}`;
const BLOCKLY_SCRIPTS = [
    `${BLOCKLY_DIR}/blockly.min.js`,
    `${BLOCKLY_DIR}/msg/ja.js`
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

/**
 * アクションのファイルに書く印。
 *
 * 中身は Blockly の保存（blocks / variables）に、こちらの素性（properties）を
 * 足したもの。形を変えたときに、古いファイルと見分けられるようにしておく
 */
const ACTION_FORMAT = "vrmtalker-action";
const ACTION_VERSION = 1;


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
            sound_category: {colour: PALETTE.sound},
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
 * @param {() => object} deps.getNames
 *        ドロップダウンに出すもの（{id, name} の並び）。編集画面を開いた
 *        時点で読み直す。中身は app-blocks.js の buildBlockUi を参照
 * @param {Promise} [deps.namesReady]
 *        その一覧が揃うまでの合図。ブロックの定義は最初に開いたとき 1 回だけ
 *        作るので、空の一覧で作ってしまわないよう、ここで待つ
 * @param {(program: object) => Promise<void>} deps.onApply
 *        組んだ内容を、動いているアバターへ反映する。会話モードへ戻るたびに呼ぶ
 * @param {object} deps.trial ブロックを試しに動かすための手立て（app.js が渡す）
 * @param {(key: string, action: (api) => Promise<void>) => Promise<void>} deps.trial.run
 * @param {(key: string) => boolean} deps.trial.isRunning
 * @param {(key: string) => void} deps.trial.stop
 * @param {(editing: boolean) => void} deps.trial.setEditing
 *        編集モードへ入る／出るとき。イベント実行の停止と再開は app.js 側が行う
 */
const createBlockEditor = ({actionsUrl, getNames, namesReady, onApply, trial}) => {

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
    let resizeObserver = null;

    /**
     * 今編集しているアクションの素性。
     *
     * ブロックとは別に持つ。Blockly の保存はブロックと変数しか返さないので、
     * 混ぜておくと保存のたびに消える（読み込むときも先に切り離す）
     */
    let properties = {name: "", description: "", author: "", created: ""};

    /**
     * サーバにあるものを読み込んだときの ID。手元で組んだものは null。
     *
     * ファイルの中には書かない。ダウンロードしたファイルが巡り巡って、他人の
     * 公開物を黙って上書きする事故を防ぐため。同じ人が同じ流れの中で直して
     * 上書きする、という使い方は、この変数が覚えていれば足りる
     */
    let actionId = null;

    /**
     * 保存していない編集があるか。
     *
     * 立っている間だけ beforeunload を付ける。付けっぱなしにすると、何も
     * 編集していない人にまで確認が出るうえ、戻るときの高速復元（bfcache）も
     * 効かなくなる。
     *
     * 編集画面を閉じるだけなら確認しない。組んだ内容は会話モードへ戻った
     * 時点で動きに反映されるので、閉じても失われないため。失われるのは
     * ページそのものを離れたときで、そこだけを引き止める
     */
    let dirty = false;

    const warnBeforeUnload = (event) => {
        event.preventDefault();
        // 文言はブラウザが決める。古い実装のために値も入れておく
        event.returnValue = "";
    };

    const setDirty = (value) => {
        if (dirty === value) {
            return;
        }
        dirty = value;
        if (dirty) {
            window.addEventListener("beforeunload", warnBeforeUnload);
        } else {
            window.removeEventListener("beforeunload", warnBeforeUnload);
        }
    };

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

    /**
     * アクション 1 つぶんの中身を組み立てる。
     *
     * ブロックと変数は Blockly が出す。素性はこちらで足す。
     * format と version は、後で形を変えたときに見分けるための印
     */
    const currentAction = () => ({
        format: ACTION_FORMAT,
        version: ACTION_VERSION,
        properties: {...properties},
        ...Blockly.serialization.workspaces.save(workspace)
    });

    /**
     * 知らないブロックを取り除く。
     *
     * Blockly は知らない型に当たると例外を投げ、そこで読み込みをやめてしまう。
     * 公開されたファイルは、こちらの都合で作り直せない。ブロックを入れ替えた
     * 後でも、読める分だけは読めるようにしておく。
     *
     * 文のつながりの途中が消えたときは、後ろを詰める（1 つ使えないブロックが
     * あったせいで、その先が丸ごと消えるほうが困る）。
     *
     * @returns {{state: object, removed: string[]}} 外した型の名前つき
     */
    const withoutUnknownBlocks = (action) => {
        const removed = [];
        const known = (type) => Boolean(Blockly.Blocks[type]);

        // つながりの先頭を返す。全部知らない型なら null
        const pruneStack = (block) => {
            while (block && ! known(block.type)) {
                removed.push(block.type);
                block = block.next?.block ?? null;
            }
            if (! block) {
                return null;
            }
            pruneInputs(block);

            const next = pruneStack(block.next?.block ?? null);
            if (next) {
                block.next = {block: next};
            } else {
                delete block.next;
            }
            return block;
        };

        // 差し込み口の中身。値ブロックも、C 型の中の列も同じように見る
        const pruneInputs = (block) => {
            for (const [name, input] of Object.entries(block.inputs ?? {})) {
                if (input.block) {
                    const kept = pruneStack(input.block);
                    if (kept) {
                        input.block = kept;
                    } else {
                        delete input.block;
                    }
                }
                if (input.shadow && ! known(input.shadow.type)) {
                    removed.push(input.shadow.type);
                    delete input.shadow;
                }
                if (! input.block && ! input.shadow) {
                    delete block.inputs[name];
                }
            }
        };

        const state = structuredClone(action);
        const tops = state.blocks?.blocks ?? [];
        state.blocks = {
            ...state.blocks,
            blocks: tops.map((block) => pruneStack(block)).filter(Boolean)
        };
        return {state, removed};
    };

    /**
     * ワークスペースへ流し込む。
     *
     * まとめて読むのが本筋だが、それが失敗したら 1 列ずつ読み直す。
     * 型は知っていても中身の形が変わっている（入力の名前が違うなど）ことが
     * あり、その 1 列のために全部が読めなくなるのを避ける
     *
     * @returns {number} 読めなかった列の数
     */
    const loadBlocks = (state) => {
        try {
            Blockly.serialization.workspaces.load(state, workspace);
            return 0;
        } catch (error) {
            console.warn("まとめて読み込めませんでした。1 列ずつ読み直します", error);
        }

        // 変数だけ先に入れてから、列を 1 つずつ足す
        workspace.clear();
        try {
            Blockly.serialization.workspaces.load(
                {variables: state.variables ?? [], blocks: {languageVersion: 0, blocks: []}},
                workspace);
        } catch (error) {
            console.warn("変数を読み込めませんでした", error);
        }

        let failed = 0;
        for (const block of state.blocks?.blocks ?? []) {
            try {
                Blockly.serialization.blocks.append(block, workspace);
            } catch (error) {
                failed += 1;
                console.warn(`ブロックの列を読み込めませんでした（${block?.type}）`, error);
            }
        }
        return failed;
    };

    /**
     * 読み込んだ中身をワークスペースへ移す。
     *
     * 素性は先に取り分ける。Blockly は知らないキーを黙って捨てるので、
     * 混ぜたままでは保存し直したときに消える
     *
     * @returns {{removed: string[], failed: number}} 欠けたものの覚え書き
     */
    const applyAction = (action) => {
        properties = {
            name: "", description: "", author: "", created: "",
            ...(action.properties ?? {})
        };
        const {state, removed} = withoutUnknownBlocks(action);
        const failed = loadBlocks(state);
        return {removed, failed};
    };

    /** 欠けたものがあれば知らせる。黙って減らさない。 */
    const reportMissing = async ({removed, failed}) => {
        if (removed.length === 0 && failed === 0) {
            return;
        }
        const lines = [];
        if (removed.length > 0) {
            const counted = [...new Set(removed)]
                  .map((type) => `${type} × ${removed.filter((t) => t === type).length}`);
            lines.push(`今のバージョンに無いブロックを外しました。\n${counted.join("\n")}`);
        }
        if (failed > 0) {
            // 途中まで並ぶこともあるので「読めなかった」と言い切らない
            lines.push(`形が変わっているブロックがあり、${failed} 本の列は`
                       + `一部しか読み込めていません。`);
        }
        console.warn(lines.join("\n"));
        await dialog.alert(
            `${lines.join("\n\n")}\n\n読める部分だけを開いています。`
                + "このまま保存すると、外れたものは元に戻りません。",
            {title: "読み込めなかったブロックがあります"});
    };

    /** 読み込む前の確認。組みかけを黙って捨てない。 */
    const confirmDiscard = async () => {
        if (! dirty) {
            return true;
        }
        return dialog.confirm("組みかけの内容があります。読み込むと消えますが、よろしいですか？", {
            title: "読み込む",
            okText: "読み込む",
            cancelText: "やめる"
        });
    };

    const loadProgram = async (url = actionsUrl) => {
        let missing = null;
        try {
            const response = await fetch(url);
            if (! response.ok) {
                throw new Error(`${response.status}`);
            }
            missing = applyAction(await response.json());
            setStatus("読み込みました");
        } catch (error) {
            console.warn(`${url} を読み込めませんでした`, error);
            setStatus("定義がありません。ブロックを組んでください");
        }
        setDirty(false);
        if (missing) {
            await reportMissing(missing);
        }
    };

    /** サーバにあるものから選んで読み込む。 */
    const loadFromServer = async () => {
        let list;
        try {
            const response = await fetch("/api/actions");
            if (! response.ok) {
                throw new Error(`${response.status}`);
            }
            list = (await response.json()).actions ?? [];
        } catch (error) {
            console.warn(error);
            await dialog.alert(`一覧を取れませんでした: ${error.message}`,
                               {title: "サーバーから読み込む"});
            return;
        }
        if (list.length === 0) {
            await dialog.alert("サーバーにアクションがありません。",
                               {title: "サーバーから読み込む", icon: ICONS.info});
            return;
        }

        // 同じ名前が並ぶことがあるので、作者と説明を手がかりに添える
        const chosen = await dialog.choose(list.map((item) => ({
            value: item.id,
            label: item.name || "（名前なし）",
            note: [item.author && `作者: ${item.author}`, item.description]
                .filter(Boolean).join(" / ")
        })), {title: "サーバーから読み込む", cancelText: "やめる"});
        if (chosen === null || ! await confirmDiscard()) {
            return;
        }

        const entry = list.find((item) => item.id === chosen);
        await loadProgram(`/api/actions/${encodeURIComponent(chosen)}`);
        // 読み取り専用のもの（同梱の見本）は上書きの相手にしない
        actionId = entry?.readonly ? null : chosen;
    };

    /** 組んだものをサーバへ公開する。合言葉が要る。 */
    const publishToServer = async () => {
        // 上書きできるのは、今このまま編集している相手だけ
        let target = null;
        if (actionId) {
            const choice = await dialog.choose([
                {value: "overwrite", label: "上書きする",
                 note: `「${properties.name || "名前なし"}」を今の内容で置き換える`},
                {value: "new", label: "新しく公開する", note: "別のものとして増やす"}
            ], {title: "サーバーに公開する", cancelText: "やめる"});
            if (choice === null) {
                return;
            }
            target = (choice === "overwrite") ? actionId : null;
        }

        const values = await dialog.form([
            {name: "name", label: "アクション名", value: properties.name, required: true},
            {name: "description", label: "説明", value: properties.description,
             multiline: true, placeholder: "どんな動きをするか"},
            {name: "author", label: "作者", value: properties.author},
            {name: "password", label: "合言葉", password: true, required: true}
        ], {
            title: target ? "上書きして公開する" : "サーバーに公開する",
            message: "公開したものは、このサーバーを開いた人が読み込めます。",
            okText: "公開する"
        });
        if (values === null) {
            return;
        }

        properties = {
            name: values.name.trim(),
            description: values.description.trim(),
            author: values.author.trim(),
            // 作り直したときも、最初に作った日付は残す
            created: properties.created || new Date().toISOString().slice(0, 10)
        };

        setStatus("公開しています…");
        try {
            const response = await fetch("/api/actions", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    password: values.password, id: target, action: currentAction()
                })
            });
            const body = await response.json().catch(() => null);
            if (! response.ok) {
                throw new Error(body?.detail || `${response.status}`);
            }
            actionId = body.id;
        } catch (error) {
            console.error(error);
            setStatus(`公開できませんでした: ${error.message}`, true);
            await dialog.alert(error.message, {title: "公開できませんでした"});
            return;
        }
        setDirty(false);
        setStatus("公開しました");
    };

    /** 手元のファイルとして保存する（ブラウザのダウンロードの仕組みを使う）。 */
    const saveToComputer = async () => {
        const name = await dialog.prompt("ファイルの名前", {
            title: "あなたのコンピュータに保存する",
            defaultValue: properties.name || "アクション",
            okText: "保存する"
        });
        if (name === null) {
            return;
        }
        properties = {
            ...properties,
            name: name.trim() || properties.name,
            created: properties.created || new Date().toISOString().slice(0, 10)
        };

        // ファイル名に使えない文字は避ける（保存先は利用者のパソコン）
        const fileName = (properties.name || "アクション").replace(/[\\/:*?"<>|]/g, "_");
        const blob = new Blob([JSON.stringify(currentAction(), null, 2) + "\n"],
                              {type: "application/json"});
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${fileName}.json`;
        link.click();
        URL.revokeObjectURL(url);

        setDirty(false);
        setStatus(`${fileName}.json に保存しました`);
    };

    /** 手元のファイルから読み込む。 */
    const loadFromComputer = async () => {
        if (! await confirmDiscard()) {
            return;
        }
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        const file = await new Promise((resolve) => {
            // 取り消されたときは change が来ない。cancel で受ける
            input.addEventListener("cancel", () => resolve(null), {once: true});
            input.addEventListener("change", () => resolve(input.files[0] ?? null),
                                    {once: true});
            input.click();
        });
        if (! file) {
            return;
        }

        let missing;
        try {
            const action = JSON.parse(await file.text());
            if (! action || typeof action !== "object" || ! action.blocks) {
                throw new Error("アクションのファイルではありません");
            }
            missing = applyAction(action);
        } catch (error) {
            console.warn(error);
            await dialog.alert(`読み込めませんでした: ${error.message}`,
                               {title: "あなたのコンピュータから読み込む"});
            return;
        }
        // 手元から来たものは、サーバのどれでもない（上書きの相手にしない）
        actionId = null;
        setDirty(false);
        setStatus(`${file.name} を読み込みました`);
        await reportMissing(missing);
    };

    /** ファイルのメニュー。バーのボタンから開く。 */
    const openFileMenu = async () => {
        const chosen = await dialog.choose([
            {value: "load-server", label: "サーバーから読み込む",
             note: "このサーバーに公開されているものを選ぶ"},
            {value: "publish", label: "サーバーに公開する",
             note: "合言葉が要る。開いた人が読み込めるようになる"},
            {value: "save-local", label: "あなたのコンピュータに保存する",
             note: "今の内容をファイルにして保存する"},
            {value: "load-local", label: "あなたのコンピュータから読み込む",
             note: "保存したファイルを読み込む"}
        ], {title: "ファイル", cancelText: "やめる"});

        switch (chosen) {
        case "load-server": await loadFromServer(); break;
        case "publish":     await publishToServer(); break;
        case "save-local":  await saveToComputer(); break;
        case "load-local":  await loadFromComputer(); break;
        }
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

    // 変数名は styles/blockly.css と合わせること（光らせる指定はあちら側）
    const updateGlowSize = (scale) => {
        area.style.setProperty("--blockly-glow-size", `${GLOW_SIZE / (scale || 1)}px`);
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
            // 画面のブロックと会話中の動きが食い違わないよう、今の内容を渡す。
            // 保存とは切り離してある。組んだそばから試せることを優先し、
            // どこかへ残すかどうかは「ファイル」のメニューで決める
            await onApply(currentAction());
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
        // 選択肢が揃うのを待つ。定義を作れるのは 1 回きりなので、
        // 空の一覧で作ってしまうと直せない（保存済みの選択まで外れる）
        await namesReady;

        for (const warning of defineBlocks(Blockly, getNames())) {
            console.warn(`ブロック定義: ${warning}`);
        }

        workspace = Blockly.inject(area, {
            // 拡大・縮小ボタンやゴミ箱の絵、効果音、カーソルの置き場所。
            // 指定しないと Blockly のサイト（static.blockly.com）から読む
            media: `${BLOCKLY_DIR}/media/`,
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
                setDirty(false);
                return;
            }
            if (! event.isUiEvent) {
                setDirty(true);
            }
            // 会話モードでは読み取り専用なので、そもそもここへ来ない
            if (event.type === Blockly.Events.CLICK && event.targetType === "block") {
                onBlockClick(event.blockId);
            }
            // 拡大縮小しても光の太さが見かけ上変わらないようにする
            if (event.type === Blockly.Events.VIEWPORT_CHANGE) {
                updateGlowSize(event.scale ?? workspace.scale);
            }
            // 会話モードでパレットを押されたとき。開いても何も出せないので、
            // 閉じたうえで切り替え方を知らせる。
            //
            // 選択を外すと oldItem だけのイベントがもう 1 度届くため、
            // newItem のあるものだけを見る（無いと繰り返しになる）
            if (event.type === Blockly.Events.TOOLBOX_ITEM_SELECT
                && event.newItem && ! editing) {
                workspace.getToolbox()?.clearSelection();
                // 押されたカテゴリから焦点を外す。外さないと、ダイアログを
                // 閉じたときに焦点がそこへ戻り、Blockly がもう一度選び直して
                // 案内が出続ける（確認済み）
                if (root.contains(document.activeElement)) {
                    document.activeElement.blur();
                }
                dialog.alert(
                    "会話モードでは、ブロックを組み替えられません。\n\n"
                        + "パレットからブロックを出したり、並べ替えたりするときは、"
                        + "上の「編集モード」に切り替えてください。",
                    {title: "会話モードです", icon: ICONS.info, okText: "閉じる"});
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

    /**
     * 閉じる。
     *
     * 保存の確認はしない。組んだ内容は会話モードへ戻る時点で動きへ反映される
     * ので、閉じても失われないため。失われるのはページを離れたときだけで、
     * そこは beforeunload が引き止める（setDirty を参照）
     */
    const close = async () => {
        // 閉じる＝会話モードへ戻る。試し実行を残したまま画面から消さない
        stopAllTrials();
        if (editing && workspace) {
            editing = false;
            workspace.setIsReadOnly(true);
            showMode(false);
            workspace.getToolbox()?.clearSelection();
            trial.setEditing(false);
            // 会話モードへ移るときと同じく、今の内容で動かす
            await onApply(currentAction());
        }
        root.removeAttribute("open");
        document.documentElement.style.removeProperty("--editor-width");
    };

    //---------------------------------- 組み立て

    root.querySelector("#editor-file").addEventListener("click", openFileMenu);
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
