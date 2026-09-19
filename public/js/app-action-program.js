/**
 * アクション定義（JSON）を解釈して実行する。
 *
 * JSON は Blockly のワークスペース形式をそのまま使う。独自形式に変換しないので、
 * 編集画面が保存したものをそのまま読める。
 *
 *   {"blocks": {"languageVersion": 0, "blocks": [ <帽子ブロック>, ... ]}}
 *
 * 帽子ブロック 1 個がイベント 1 つのアクションになる。その下に next で
 * つながったブロックが、上から順に実行される本体。
 *
 * ブロックの種類は 2 つしかない。
 *
 *   制御            繰り返し・条件・応答ループ。このファイルが解釈する
 *   それ以外        CALL_BLOCKS / VALUE_BLOCKS の表を引いて api の関数を呼ぶ
 *
 * 後者を表に寄せてあるので、api に関数を足してもこのファイルの処理は変わらない。
 * 表に 1 行足すだけでブロックが増える。
 *
 * 生成された JavaScript を実行する方式は採っていない。実行時に Blockly
 * （782KB）を読み込まずに済ませるため。編集画面だけが Blockly を持つ。
 */

/** この実装が想定している Blockly のシリアライズ版。 */
const SUPPORTED_LANGUAGE_VERSION = 0;

/** 帽子ブロックの型 → イベント名。 */
export const EVENT_BLOCKS = Object.freeze({
    event_ready: "ready",
    event_idle: "idle",
    event_listenstart: "listenstart",
    event_speechstart: "speechstart",
    event_speechend: "speechend",
    event_listenend: "listenend",
    event_error: "error"
});

/**
 * 文のブロック → api の関数。
 *
 * ここに 1 行足せばブロックが 1 個増える。args は入力の名前を並べたもので、
 * その順で関数へ渡される。api の関数はすべて await して構わない
 * （待たない版は undefined を返すので、await しても即座に進む）
 */
export const CALL_BLOCKS = Object.freeze({
    // アバター
    avatar_speak:             {fn: "speak",                   args: ["TEXT"]},
    avatar_speak_and_wait:    {fn: "speakAndWait",            args: ["TEXT"]},
    avatar_play_sound:        {fn: "playSound",               args: ["URL"]},
    avatar_play_sound_wait:   {fn: "playSoundAndWait",        args: ["URL"]},
    avatar_stop_speaking:     {fn: "stopSpeaking",            args: []},
    avatar_play_motion:       {fn: "playMotion",              args: ["NAME"]},
    avatar_play_motion_wait:  {fn: "playMotionAndWait",       args: ["NAME"]},
    avatar_set_expression:    {fn: "setExpression",           args: ["NAME", "VALUE"]},
    avatar_change_expression: {fn: "changeExpression",        args: ["NAME", "VALUE", "SECONDS"]},
    avatar_change_expression_wait:
                              {fn: "changeExpressionAndWait", args: ["NAME", "VALUE", "SECONDS"]},
    avatar_clear_expression:  {fn: "clearExpression",         args: []},
    avatar_look_at:           {fn: "lookAt",                  args: ["BONE"]},
    avatar_show_emote:        {fn: "showEmote",               args: ["NAME", "SECONDS"]},
    avatar_show_emote_wait:   {fn: "showEmoteAndWait",        args: ["NAME", "SECONDS"]},
    avatar_clear_emote:       {fn: "clearEmote",              args: []},

    // 画面
    screen_show_bubble:       {fn: "showBubble",              args: ["WHO", "TEXT"]},
    screen_clear_bubbles:     {fn: "clearBubbles",            args: []},

    // 会話
    chat_reply:               {fn: "reply",                   args: ["PROMPT"]},
    chat_clear_history:       {fn: "clearHistory",            args: []},

    // 制御（値を返さないもの）
    control_wait:             {fn: "wait",                    args: ["SECONDS"]}
});

/** 値のブロック → api の関数。 */
export const VALUE_BLOCKS = Object.freeze({
    value_user_text:      {fn: "userText",      args: []},
    value_character_name: {fn: "characterName", args: []},
    operator_random:      {fn: "random",        args: ["FROM", "TO"]},
    operator_includes:    {fn: "includes",      args: ["TEXT", "WORD"]},
    // 入力 2 つの横長な結合。入力を増やせる text_join も残してある
    operator_join:        {fn: "join",          args: ["STRING1", "STRING2"]}
});

/** イベントの detail から読む値のブロック。 */
export const DETAIL_BLOCKS = Object.freeze({
    value_error_message: "message",
    value_error_phase: "phase"
});


/** このファイルが直接解釈するブロック。表に無くても知らないブロックではない。 */
const BUILTIN_BLOCKS = Object.freeze([
    // 制御
    "control_repeat", "control_forever",
    "control_if", "control_if_else",
    // controls_if は Blockly 標準の歯車付き。パレットからは外したが、
    // 以前の定義がそのまま動くよう解釈だけは残してある
    "controls_if",
    "chat_reply_each_sentence", "variables_set",
    // 値
    "text", "math_number", "logic_boolean", "variables_get", "text_join",
    "math_arithmetic", "logic_compare", "logic_operation", "logic_negate"
]);

/** 定義に出てくるブロックの型をすべて集める。読み込み時の検査に使う。 */
const collectBlockTypes = (block, into) => {
    if (! block) {
        return;
    }
    into.add(block.type);
    for (const input of Object.values(block.inputs ?? {})) {
        collectBlockTypes(input.block ?? input.shadow ?? null, into);
    }
    collectBlockTypes(block.next?.block ?? null, into);
};


/**
 * ブロックの木のたどり方。
 *
 * インタプリタが歩く対象は 2 種類ある。両者の違いはここだけに閉じ込めてあり、
 * 実行の中身（evaluate / runStatements）はどちらでも同じものを使う。
 *
 *   保存形式  イベント実行で使う。actions.json を読んだ時点のスナップショット。
 *             走っている間に編集されても影響を受けない（受けさせない）
 *   生ブロック 編集画面のクリック実行で使う。ワークスペースを直接歩くので、
 *             実行中に編集すると次にそのブロックを通ったときから反映される
 *             （Scratch と同じ挙動）
 */

/** 保存形式（Blockly のシリアライズ JSON）をたどる。 */
const createJsonTree = (variableNames) => ({
    type: (block) => block.type,
    next: (block) => block.next?.block ?? null,
    input: (block, name) => {
        const input = block?.inputs?.[name];
        return input?.block ?? input?.shadow ?? null;
    },
    hasInput: (block, name) => block?.inputs?.[name] !== undefined,
    field: (block, name) => block?.fields?.[name],
    hasField: (block, name) => Boolean(block?.fields) && (name in block.fields),
    alive: () => true,
    // 変数は id で参照される。保存形式では名前が併記されることもある
    variableName: (field) => {
        if (field && typeof field === "object") {
            return field.name ?? variableNames.get(field.id) ?? String(field.id);
        }
        return String(field ?? "");
    }
});

/**
 * 生の Blockly ブロックをたどる。
 *
 * 差し込み口が空なら影のブロックが返る点は保存形式と同じ意味になる。
 * alive() を見ているのは、実行中にブロックが消される場合があるため
 */
export const LIVE_TREE = Object.freeze({
    type: (block) => block.type,
    next: (block) => block.getNextBlock(),
    input: (block, name) => block.getInputTargetBlock(name),
    hasInput: (block, name) => Boolean(block.getInput(name)),
    field: (block, name) => block.getFieldValue(name),
    hasField: (block, name) => Boolean(block.getField(name)),
    alive: (block) => Boolean(block) && ! block.isDisposed(),
    // 生のブロックのフィールドは変数の id を返すので、名前に引き直す。
    // 引き直しは getVariableMap() 経由でしか行えない
    // （Workspace 直下の getVariableById は Blockly 13 に無い）
    variableName: (field, block) =>
        block?.workspace?.getVariableMap?.()?.getVariableById?.(field)?.name
        ?? String(field ?? "")
});


/**
 * ブロックを実行する本体。
 *
 * 木のたどり方（tree）だけを差し替えれば、保存形式でも生のブロックでも
 * 同じ実装が動く。
 *
 * @param {object} tree 上の createJsonTree か LIVE_TREE
 * @param {(message: string) => void} warnOnce
 */
const createInterpreter = (tree, warnOnce) => {

    const inputBlock = (block, name) => tree.input(block, name);
    const hasInput = (block, name) => tree.hasInput(block, name);
    const fieldValue = (block, name) => tree.field(block, name);
    const hasField = (block, name) => tree.hasField(block, name);
    const nextBlock = (block) => tree.next(block);
    const blockType = (block) => tree.type(block);
    const variableName = (field, block) => tree.variableName(field, block);

    //---------------------------------- 値の評価

    /**
     * 引数を 1 つ読む。
     *
     * ドロップダウン（モーション名・表情名など）はフィールドとして、
     * 差し込み口に別のブロックを入れられるものは入力として保存される。
     * どちらの形でも受けられるようにしておく
     */
    const readArgument = async (block, name, ctx) => {
        if (hasField(block, name)) {
            return fieldValue(block, name);
        }
        return evaluate(inputBlock(block, name), ctx);
    };

    const evaluate = async (block, ctx) => {
        if (! block) {
            return undefined;
        }
        // api の関数を呼ぶ値ブロック
        const call = VALUE_BLOCKS[blockType(block)];
        if (call) {
            const args = [];
            for (const name of call.args) {
                args.push(await readArgument(block, name, ctx));
            }
            return ctx.api[call.fn](...args);
        }

        // イベントの detail から読む
        const detailKey = DETAIL_BLOCKS[blockType(block)];
        if (detailKey) {
            return ctx.detail?.[detailKey] ?? "";
        }

        switch (blockType(block)) {
        case "text":
            return String(fieldValue(block, "TEXT") ?? "");

        case "math_number":
            return Number(fieldValue(block, "NUM") ?? 0);

        case "logic_boolean":
            return fieldValue(block, "BOOL") === "TRUE";

        case "variables_get":
            return ctx.variables.get(variableName(fieldValue(block, "VAR"), block)) ?? "";

        case "text_join": {
            // 入力の数は可変。ADD0 から順に無くなるまで見る
            let joined = "";
            for (let i = 0; hasInput(block, `ADD${i}`); i++) {
                joined += String(await evaluate(inputBlock(block, `ADD${i}`), ctx) ?? "");
            }
            return joined;
        }

        case "math_arithmetic": {
            const a = Number(await evaluate(inputBlock(block, "A"), ctx)) || 0;
            const b = Number(await evaluate(inputBlock(block, "B"), ctx)) || 0;
            switch (fieldValue(block, "OP")) {
            case "ADD":      return a + b;
            case "MINUS":    return a - b;
            case "MULTIPLY": return a * b;
            case "DIVIDE":   return (b === 0) ? 0 : a / b;
            case "POWER":    return a ** b;
            default:         return a;
            }
        }

        case "logic_compare": {
            const a = await evaluate(inputBlock(block, "A"), ctx);
            const b = await evaluate(inputBlock(block, "B"), ctx);
            switch (fieldValue(block, "OP")) {
            case "EQ":  return a === b;
            case "NEQ": return a !== b;
            case "LT":  return a < b;
            case "LTE": return a <= b;
            case "GT":  return a > b;
            case "GTE": return a >= b;
            default:    return false;
            }
        }

        case "logic_operation": {
            const a = Boolean(await evaluate(inputBlock(block, "A"), ctx));
            // OR は左が真なら右を見ない（右に時間のかかる処理が入る場合のため）
            if (fieldValue(block, "OP") === "OR") {
                return a || Boolean(await evaluate(inputBlock(block, "B"), ctx));
            }
            return a && Boolean(await evaluate(inputBlock(block, "B"), ctx));
        }

        case "logic_negate":
            return ! Boolean(await evaluate(inputBlock(block, "BOOL"), ctx));

        default:
            warnOnce(`知らない値ブロックです: ${blockType(block)}`);
            return undefined;
        }
    };

    //---------------------------------- 文の実行

    const runStatements = async (block, ctx) => {
        let current = block;
        while (current) {
            // 生のブロックを歩いているときは、実行中に消される場合がある。
            // 消えた先へ進もうとすると失敗するので、そこで静かに終える
            if (! tree.alive(current)) {
                return;
            }
            await runStatement(current, ctx);
            current = nextBlock(current);
        }
    };

    const runStatement = async (block, ctx) => {
        // api の関数を呼ぶ文ブロック。待たない版は undefined を返すので
        // await しても即座に進む。ここで種類を分けなくてよい
        const call = CALL_BLOCKS[blockType(block)];
        if (call) {
            const args = [];
            for (const name of call.args) {
                args.push(await readArgument(block, name, ctx));
            }
            await ctx.api[call.fn](...args);
            return;
        }

        switch (blockType(block)) {
        case "control_repeat": {
            const times = Number(await evaluate(inputBlock(block, "TIMES"), ctx)) || 0;
            for (let i = 0; i < times; i++) {
                if (! tree.alive(block)) {
                    return;
                }
                // 中身は毎周取り直す。生のブロックを歩いているとき、
                // 実行中に組み替えられたら次の周から反映されるようにするため
                await runStatements(inputBlock(block, "DO"), ctx);
                // 中断の確認と、画面を固まらせないための譲渡
                await ctx.api.tick();
            }
            return;
        }

        case "control_forever": {
            while (true) {
                // ループ自身が消されたら終わる。これが無いと、中身を消された
                // 「ずっと」が何もしないまま回り続ける
                if (! tree.alive(block)) {
                    return;
                }
                await runStatements(inputBlock(block, "DO"), ctx);
                await ctx.api.tick();
            }
        }

        case "control_if": {
            if (await evaluate(inputBlock(block, "CONDITION"), ctx)) {
                await runStatements(inputBlock(block, "DO"), ctx);
            }
            return;
        }

        case "control_if_else": {
            if (await evaluate(inputBlock(block, "CONDITION"), ctx)) {
                await runStatements(inputBlock(block, "DO"), ctx);
            } else {
                await runStatements(inputBlock(block, "ELSE"), ctx);
            }
            return;
        }

        case "controls_if": {
            // else if の数は可変。IF0 から順に無くなるまで見る
            for (let i = 0; hasInput(block, `IF${i}`); i++) {
                if (await evaluate(inputBlock(block, `IF${i}`), ctx)) {
                    await runStatements(inputBlock(block, `DO${i}`), ctx);
                    return;
                }
            }
            if (hasInput(block, "ELSE")) {
                await runStatements(inputBlock(block, "ELSE"), ctx);
            }
            return;
        }

        case "chat_reply_each_sentence": {
            const prompt = await readArgument(block, "PROMPT", ctx);
            // 生のブロックではフィールドが変数の id を返すので、ブロックを渡して
            // 名前に引き直す。渡さないと variables_get 側と食い違う
            const name = variableName(fieldValue(block, "SENTENCE"), block);
            for await (const sentence of ctx.api.replySentences(prompt)) {
                ctx.variables.set(name, sentence);
                await runStatements(inputBlock(block, "DO"), ctx);
                await ctx.api.tick();
            }
            return;
        }

        case "variables_set": {
            const name = variableName(fieldValue(block, "VAR"), block);
            ctx.variables.set(name, await evaluate(inputBlock(block, "VALUE"), ctx));
            return;
        }

        default:
            warnOnce(`知らないブロックです: ${blockType(block)}`);
        }
    };

    return {runStatements};
};


/**
 * 保存形式（actions.json）を、イベントごとのアクションに変換する。
 *
 * ここで作ったハンドラはスナップショットを歩く。アプリが実際に動かすのは
 * 保存したものであるべきなので、編集中のワークスペースは見ない
 *
 * @param {object} json Blockly のワークスペース形式
 * @returns {{handlers: object, blockTypes: string[], warnings: string[]}}
 */
const createActionProgram = (json) => {
    const warnings = [];
    const handlers = {};
    const blockTypes = new Set();

    const languageVersion = json?.blocks?.languageVersion;
    if (languageVersion !== undefined && languageVersion !== SUPPORTED_LANGUAGE_VERSION) {
        warnings.push(`Blockly の形式の版が想定と違います`
                      + `（${languageVersion} / 想定 ${SUPPORTED_LANGUAGE_VERSION}）。`
                      + `動かない場合は編集画面で保存し直してください。`);
    }

    const warnOnce = (message) => {
        if (! warnings.includes(message)) {
            warnings.push(message);
        }
    };

    // 変数は id で参照されるので、名前を引けるようにしておく
    const variableNames = new Map();
    for (const variable of json?.variables ?? []) {
        if (variable?.id) {
            variableNames.set(variable.id, variable.name ?? variable.id);
        }
    }

    const {runStatements} = createInterpreter(createJsonTree(variableNames), warnOnce);

    //---------------------------------- 帽子ブロックをイベントごとに束ねる

    for (const hat of json?.blocks?.blocks ?? []) {
        const eventType = EVENT_BLOCKS[hat?.type];
        if (! eventType) {
            // 帽子につながっていないブロックは、編集画面でクリックして
            // 単体で試すためのもの。置いてあるのが普通なので何も言わない
            // （イベント実行では動かないだけ）
            continue;
        }
        if (handlers[eventType]) {
            warnOnce(`"${eventType}" のブロックが複数あります。最初のものだけを使います。`);
            continue;
        }

        const body = hat.next?.block ?? null;
        collectBlockTypes(body, blockTypes);

        handlers[eventType] = async (api, detail) => {
            await runStatements(body, {api, detail, variables: new Map()});
        };
    }

    // 知らないブロックは読み込んだ時点で知らせる。実行されるまで分からないと、
    // めったに通らない枝の間違いに気づけない
    for (const type of blockTypes) {
        const known = BUILTIN_BLOCKS.includes(type)
              || CALL_BLOCKS[type] || VALUE_BLOCKS[type] || DETAIL_BLOCKS[type];
        if (! known) {
            warnOnce(`知らないブロックです: ${type}`);
        }
    }

    return {handlers, blockTypes: [...blockTypes], warnings};
};


/**
 * 生のブロック列を 1 本だけ実行する関数を作る。編集画面のクリック実行で使う。
 *
 * 帽子ブロックから始まる列なら、帽子の下から始める。帽子のない裸の列なら
 * 先頭から始める。どちらもワークスペースを直接歩くので、実行中に編集すると
 * 次にそこを通ったときから反映される
 *
 * イベントから呼ばれたわけではないので detail は空。「エラーの内容」などは
 * 空文字になる
 *
 * @param {object} rootBlock 列の先頭にある生の Blockly ブロック
 * @returns {(api: object) => Promise<void>}
 */
export const createStackAction = (rootBlock) => {
    const warnings = [];
    const warnOnce = (message) => {
        if (! warnings.includes(message)) {
            warnings.push(message);
            console.warn(`アクション: ${message}`);
        }
    };

    const {runStatements} = createInterpreter(LIVE_TREE, warnOnce);
    const start = EVENT_BLOCKS[rootBlock?.type]
          ? rootBlock.getNextBlock()
          : rootBlock;

    return async (api) => {
        await runStatements(start, {api, detail: {}, variables: new Map()});
    };
};

export default createActionProgram;
