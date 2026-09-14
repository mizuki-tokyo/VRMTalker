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
    avatar_look_at:           {fn: "lookAt",                  args: ["BONE"]},
    avatar_show_emote:        {fn: "showEmote",               args: ["NAME", "SECONDS"]},
    avatar_show_emote_wait:   {fn: "showEmoteAndWait",        args: ["NAME", "SECONDS"]},
    avatar_clear_emote:       {fn: "clearEmote",              args: []},

    // 画面
    screen_show_bubble:       {fn: "showBubble",              args: ["WHO", "TEXT"]},
    screen_clear_bubbles:     {fn: "clearBubbles",            args: []},

    // 会話
    chat_reply:               {fn: "reply",                   args: ["PROMPT"]},

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


/** ブロックの入力から、実際につながっているブロックを取り出す。 */
const inputBlock = (block, name) => {
    const input = block?.inputs?.[name];
    return input?.block ?? input?.shadow ?? null;
};

/** フィールドの値。変数フィールドは {id, name} の形で入ることがある。 */
const fieldValue = (block, name) => block?.fields?.[name];

/** そのブロックが name をフィールドとして持っているか。 */
const hasField = (block, name) => Boolean(block?.fields) && (name in block.fields);


/**
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

    // 変数は id で参照されるので、名前を引けるようにしておく
    const variableNames = new Map();
    for (const variable of json?.variables ?? []) {
        if (variable?.id) {
            variableNames.set(variable.id, variable.name ?? variable.id);
        }
    }

    const variableName = (field) => {
        if (field && typeof field === "object") {
            return field.name ?? variableNames.get(field.id) ?? String(field.id);
        }
        return String(field ?? "");
    };

    const warnOnce = (message) => {
        if (! warnings.includes(message)) {
            warnings.push(message);
        }
    };

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
        const call = VALUE_BLOCKS[block.type];
        if (call) {
            const args = [];
            for (const name of call.args) {
                args.push(await readArgument(block, name, ctx));
            }
            return ctx.api[call.fn](...args);
        }

        // イベントの detail から読む
        const detailKey = DETAIL_BLOCKS[block.type];
        if (detailKey) {
            return ctx.detail?.[detailKey] ?? "";
        }

        switch (block.type) {
        case "text":
            return String(fieldValue(block, "TEXT") ?? "");

        case "math_number":
            return Number(fieldValue(block, "NUM") ?? 0);

        case "logic_boolean":
            return fieldValue(block, "BOOL") === "TRUE";

        case "variables_get":
            return ctx.variables.get(variableName(fieldValue(block, "VAR"))) ?? "";

        case "text_join": {
            // 入力の数は可変。ADD0 から順に無くなるまで見る
            let joined = "";
            for (let i = 0; block.inputs?.[`ADD${i}`] !== undefined; i++) {
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
            warnOnce(`知らない値ブロックです: ${block.type}`);
            return undefined;
        }
    };

    //---------------------------------- 文の実行

    const runStatements = async (block, ctx) => {
        let current = block;
        while (current) {
            await runStatement(current, ctx);
            current = current.next?.block ?? null;
        }
    };

    const runStatement = async (block, ctx) => {
        // api の関数を呼ぶ文ブロック。待たない版は undefined を返すので
        // await しても即座に進む。ここで種類を分けなくてよい
        const call = CALL_BLOCKS[block.type];
        if (call) {
            const args = [];
            for (const name of call.args) {
                args.push(await readArgument(block, name, ctx));
            }
            await ctx.api[call.fn](...args);
            return;
        }

        switch (block.type) {
        case "control_repeat": {
            const times = Number(await evaluate(inputBlock(block, "TIMES"), ctx)) || 0;
            const body = inputBlock(block, "DO");
            for (let i = 0; i < times; i++) {
                await runStatements(body, ctx);
                // 中断の確認と、画面を固まらせないための譲渡
                await ctx.api.tick();
            }
            return;
        }

        case "control_forever": {
            const body = inputBlock(block, "DO");
            while (true) {
                await runStatements(body, ctx);
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
            for (let i = 0; block.inputs?.[`IF${i}`] !== undefined; i++) {
                if (await evaluate(inputBlock(block, `IF${i}`), ctx)) {
                    await runStatements(inputBlock(block, `DO${i}`), ctx);
                    return;
                }
            }
            if (block.inputs?.ELSE !== undefined) {
                await runStatements(inputBlock(block, "ELSE"), ctx);
            }
            return;
        }

        case "chat_reply_each_sentence": {
            const prompt = await readArgument(block, "PROMPT", ctx);
            const name = variableName(fieldValue(block, "SENTENCE"));
            const body = inputBlock(block, "DO");
            for await (const sentence of ctx.api.replySentences(prompt)) {
                ctx.variables.set(name, sentence);
                await runStatements(body, ctx);
                await ctx.api.tick();
            }
            return;
        }

        case "variables_set": {
            const name = variableName(fieldValue(block, "VAR"));
            ctx.variables.set(name, await evaluate(inputBlock(block, "VALUE"), ctx));
            return;
        }

        default:
            warnOnce(`知らないブロックです: ${block.type}`);
        }
    };

    //---------------------------------- 帽子ブロックをイベントごとに束ねる

    for (const hat of json?.blocks?.blocks ?? []) {
        const eventType = EVENT_BLOCKS[hat?.type];
        if (! eventType) {
            if (hat?.type) {
                warnOnce(`イベントではないブロックが置かれています: ${hat.type}`);
            }
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

export default createActionProgram;
