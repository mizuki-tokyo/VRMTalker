/**
 * アクション定義（JSON）を解釈して実行する。
 *
 * JSON は Blockly のワークスペース形式をそのまま使う。独自形式に変換しないので、
 * 編集画面が保存したものをそのまま読める。
 *
 *   {"blocks": {"languageVersion": 0, "blocks": [ <帽子ブロック>, ... ]}}
 *
 * 帽子ブロックの下に next でつながったブロックが、上から順に実行される本体。
 * 同じイベントの帽子ブロックが複数あれば、それらを束ねて 1 つのアクションにし、
 * すべての並びを同時に走らせる（Scratch と同じ）。アクションが終わるのは、
 * すべての並びが終わったとき。変数は、すべての並びで共有する（Scratch と同じ）。
 *
 * ブロックの種類は 2 つしかない。
 *
 *   制御            繰り返し・条件・応答ループ。このファイルが解釈する
 *   それ以外        CALL_BLOCKS / VALUE_BLOCKS の表を引いて api の関数を呼ぶ
 *
 * 後者を表に寄せてあるので、api に関数を足してもこのファイルの処理は変わらない。
 * 表に 1 行足すだけでブロックが増える。
 *
 * 処理を譲る場所（Scratch と同じ）
 * --------------------------------
 * 並びは同時に動くが、ほかの並びに処理を譲るのは次の場所だけにしてある。
 *
 *   - 待つブロック（api の関数が Promise を返すもの。「〜秒待つ」「話して終わる
 *     まで待つ」など）と、返事を待つブロック
 *   - くりかえしの 1 周の終わり
 *
 * 計算や「変数を〜にする」は、途中で譲らずに一気に終わる。そのため、2 本の
 * 並びが同時に「x を x＋1 にする」を行っても、加算が欠けない。値を求めるたびに
 * await すると、そのたびに処理を譲ってしまうので、待つ必要の無い値はその場で
 * 求め、Promise が返ってきたときだけ待つ（andThen / inOrder）。
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
    avatar_play_voice:        {fn: "playVoice",               args: ["VOICE"]},
    avatar_play_voice_wait:   {fn: "playVoiceAndWait",        args: ["VOICE"]},
    avatar_stop_speaking:     {fn: "stopSpeaking",            args: []},
    avatar_play_motion:       {fn: "playMotion",              args: ["NAME"]},
    avatar_play_motion_wait:  {fn: "playMotionAndWait",       args: ["NAME"]},
    avatar_take_pose:         {fn: "takePose",                args: ["NAME"]},
    avatar_take_pose_for:     {fn: "takePoseFor",             args: ["NAME", "SECONDS"]},
    avatar_take_pose_for_wait:
                              {fn: "takePoseForAndWait",      args: ["NAME", "SECONDS"]},
    avatar_stop_pose:         {fn: "stopPose",                args: []},
    avatar_play_gesture:      {fn: "playGesture",             args: ["HAND", "NAME", "SECONDS"]},
    avatar_play_gesture_wait: {fn: "playGestureAndWait",      args: ["HAND", "NAME", "SECONDS"]},
    avatar_stop_gesture:      {fn: "stopGesture",             args: []},
    avatar_set_expression:    {fn: "setExpression",           args: ["NAME", "VALUE"]},
    avatar_change_expression: {fn: "changeExpression",        args: ["NAME", "VALUE", "SECONDS"]},
    avatar_change_expression_wait:
                              {fn: "changeExpressionAndWait", args: ["NAME", "VALUE", "SECONDS"]},
    avatar_clear_expression:  {fn: "clearExpression",         args: []},
    avatar_clear_expression_in:
                              {fn: "clearExpressionIn",       args: ["SECONDS"]},
    avatar_clear_expression_in_wait:
                              {fn: "clearExpressionInAndWait", args: ["SECONDS"]},
    avatar_look_at:           {fn: "lookAt",                  args: ["BONE"]},
    avatar_gaze_camera:       {fn: "gazeAtCamera",            args: []},
    avatar_gaze_follow:       {fn: "gazeFollowCamera",        args: []},
    avatar_gaze_to:           {fn: "gazeTo",                  args: ["DIRECTION", "DEGREES"]},
    avatar_show_emote:        {fn: "showEmote",               args: ["NAME", "SECONDS"]},
    avatar_show_emote_wait:   {fn: "showEmoteAndWait",        args: ["NAME", "SECONDS"]},
    avatar_clear_emote:       {fn: "clearEmote",              args: []},

    // 効果音
    sound_play:               {fn: "playSoundEffect",         args: ["NAME"]},
    sound_play_wait:          {fn: "playSoundEffectAndWait",  args: ["NAME"]},
    sound_stop:               {fn: "stopSoundEffects",        args: []},

    // 画面
    screen_show_bubble:       {fn: "showBubble",              args: ["WHO", "TEXT"]},
    screen_clear_bubbles:     {fn: "clearBubbles",            args: []},
    screen_show_toast:        {fn: "showToast",               args: ["TEXT", "SECONDS"]},
    screen_set_background:    {fn: "setBackground",           args: ["NAME"]},

    // 会話
    chat_reply:               {fn: "reply",                   args: ["PROMPT"]},
    chat_clear_history:       {fn: "clearHistory",            args: []},

    // 制御（値を返さないもの）
    control_wait:             {fn: "wait",                    args: ["SECONDS"]},
    control_stopwatch:        {fn: "controlStopwatch",        args: ["ACTION"]}
});

/** 値のブロック → api の関数。 */
export const VALUE_BLOCKS = Object.freeze({
    value_user_text:      {fn: "userText",      args: []},
    value_character_name: {fn: "characterName", args: []},
    operator_random:      {fn: "random",        args: ["FROM", "TO"]},
    operator_includes:    {fn: "includes",      args: ["TEXT", "WORD"]},
    operator_current:     {fn: "currentTime",   args: ["UNIT"]},
    value_stopwatch:      {fn: "stopwatch",     args: []},
    chat_reply_emotion:   {fn: "replyHasEmotion", args: ["EMOTION"]},
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


/** 待つ必要があるか（Promise などの thenable か）。 */
const isPending = (value) => typeof value?.then === "function";

/**
 * 値が出たら fn に渡す。待つ必要が無ければその場で、あれば待ってから。
 * @returns fn の戻り値（待ったときは、それを解決する Promise）
 */
const andThen = (value, fn) => isPending(value) ? value.then(fn) : fn(value);

/**
 * 読む関数を左から順に呼び、全部の値を並べて fn に渡す。
 *
 * 前の値が出てから次を読む（同時には読まない）。試し実行の「ユーザの発話」の
 * ように入力を求めるものが 2 つあるとき、問いが同時に 2 つ出ないようにするため。
 * どれも待たずに値が出れば、その場で fn を呼ぶ
 *
 * @param {Array<() => *>} readers
 * @param {(values: Array) => *} fn
 */
const inOrder = (readers, fn) => {
    const values = [];
    for (let i = 0; i < readers.length; i++) {
        const value = readers[i]();
        if (isPending(value)) {
            // ここから先は、1 つずつ待ちながら読む
            return (async () => {
                values.push(await value);
                for (let j = i + 1; j < readers.length; j++) {
                    values.push(await readers[j]());
                }
                return fn(values);
            })();
        }
        values.push(value);
    }
    return fn(values);
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
    const readArgument = (block, name, ctx) => {
        if (hasField(block, name)) {
            return fieldValue(block, name);
        }
        return evaluate(inputBlock(block, name), ctx);
    };

    /** 引数の名前の並びを、順に読む関数の並びにする（inOrder に渡す形）。 */
    const argumentReaders = (block, names, ctx) =>
          names.map((name) => () => readArgument(block, name, ctx));

    /**
     * 値を求める。待つ必要が無ければその場で値を返し、待つものがあれば
     * Promise を返す（このファイルの先頭の「処理を譲る場所」を参照）
     */
    const evaluate = (block, ctx) => {
        if (! block) {
            return undefined;
        }
        // api の関数を呼ぶ値ブロック
        const call = VALUE_BLOCKS[blockType(block)];
        if (call) {
            return inOrder(argumentReaders(block, call.args, ctx),
                           (args) => ctx.api[call.fn](...args));
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
            const readers = [];
            for (let i = 0; hasInput(block, `ADD${i}`); i++) {
                readers.push(() => evaluate(inputBlock(block, `ADD${i}`), ctx));
            }
            return inOrder(readers,
                           (values) => values.map((value) => String(value ?? "")).join(""));
        }

        case "math_arithmetic":
            return inOrder(argumentReaders(block, ["A", "B"], ctx), ([a, b]) => {
                a = Number(a) || 0;
                b = Number(b) || 0;
                switch (fieldValue(block, "OP")) {
                case "ADD":      return a + b;
                case "MINUS":    return a - b;
                case "MULTIPLY": return a * b;
                case "DIVIDE":   return (b === 0) ? 0 : a / b;
                case "POWER":    return a ** b;
                default:         return a;
                }
            });

        case "logic_compare":
            return inOrder(argumentReaders(block, ["A", "B"], ctx), ([a, b]) => {
                switch (fieldValue(block, "OP")) {
                case "EQ":  return a === b;
                case "NEQ": return a !== b;
                case "LT":  return a < b;
                case "LTE": return a <= b;
                case "GT":  return a > b;
                case "GTE": return a >= b;
                default:    return false;
                }
            });

        case "logic_operation":
            // OR は左が真なら右を見ない（右に時間のかかる処理が入る場合のため）。
            // AND は左が偽なら右を見ない
            return andThen(evaluate(inputBlock(block, "A"), ctx), (a) => {
                const isOr = fieldValue(block, "OP") === "OR";
                if (Boolean(a) === isOr) {
                    return isOr;
                }
                return andThen(evaluate(inputBlock(block, "B"), ctx), Boolean);
            });

        case "logic_negate":
            return andThen(evaluate(inputBlock(block, "BOOL"), ctx), (value) => ! value);

        default:
            warnOnce(`知らない値ブロックです: ${blockType(block)}`);
            return undefined;
        }
    };

    //---------------------------------- 文の実行

    /**
     * つながった文を上から順に実行する。待つものが無ければその場で終わり、
     * 待つものがあれば Promise を返す（evaluate と同じ）
     */
    const runStatements = (block, ctx) => {
        let current = block;
        while (current) {
            // 生のブロックを歩いているときは、実行中に消される場合がある。
            // 消えた先へ進もうとすると失敗するので、そこで静かに終える
            if (! tree.alive(current)) {
                return undefined;
            }
            const pending = runStatement(current, ctx);
            if (isPending(pending)) {
                // 待ち終えてから次をたどる（待つ間に組み替えられても、その時点の次へ進む）
                const waited = current;
                return pending.then(() => runStatements(nextBlock(waited), ctx));
            }
            current = nextBlock(current);
        }
        return undefined;
    };

    /** 条件を求めて、成り立てば then を、成り立たなければ otherwise を実行する。 */
    const runIf = (block, conditionName, ctx, then, otherwise = null) =>
          andThen(evaluate(inputBlock(block, conditionName), ctx), (condition) => {
              if (condition) {
                  return runStatements(inputBlock(block, then), ctx);
              }
              return otherwise ? runStatements(inputBlock(block, otherwise), ctx) : undefined;
          });

    const runStatement = (block, ctx) => {
        // api の関数を呼ぶ文ブロック。待たない版は undefined を返すので、
        // そのまま次へ進む。待つ版は Promise を返すので、そこで処理を譲る
        const call = CALL_BLOCKS[blockType(block)];
        if (call) {
            return inOrder(argumentReaders(block, call.args, ctx),
                           (args) => ctx.api[call.fn](...args));
        }

        switch (blockType(block)) {
        case "control_repeat":
            return andThen(evaluate(inputBlock(block, "TIMES"), ctx), async (value) => {
                const times = Number(value) || 0;
                for (let i = 0; i < times; i++) {
                    if (! tree.alive(block)) {
                        return;
                    }
                    // 中身は毎周取り直す。生のブロックを歩いているとき、
                    // 実行中に組み替えられたら次の周から反映されるようにするため
                    await runStatements(inputBlock(block, "DO"), ctx);
                    // 1 周ごとに処理を譲る。中断の確認と、画面を固まらせないため
                    await ctx.api.tick();
                }
            });

        case "control_forever":
            return (async () => {
                while (true) {
                    // ループ自身が消されたら終わる。これが無いと、中身を消された
                    // 「ずっと」が何もしないまま回り続ける
                    if (! tree.alive(block)) {
                        return;
                    }
                    await runStatements(inputBlock(block, "DO"), ctx);
                    await ctx.api.tick();
                }
            })();

        case "control_if":
            return runIf(block, "CONDITION", ctx, "DO");

        case "control_if_else":
            return runIf(block, "CONDITION", ctx, "DO", "ELSE");

        case "controls_if": {
            // else if の数は可変。IF0 から順に、成り立つものが見つかるまで見る
            const tryBranch = (i) => {
                if (! hasInput(block, `IF${i}`)) {
                    return hasInput(block, "ELSE")
                        ? runStatements(inputBlock(block, "ELSE"), ctx) : undefined;
                }
                return andThen(evaluate(inputBlock(block, `IF${i}`), ctx), (condition) =>
                    condition ? runStatements(inputBlock(block, `DO${i}`), ctx)
                              : tryBranch(i + 1));
            };
            return tryBranch(0);
        }

        case "chat_reply_each_sentence":
            // 返事を待つので、いつも処理を譲る
            return (async () => {
                const prompt = await readArgument(block, "PROMPT", ctx);
                // 生のブロックではフィールドが変数の id を返すので、ブロックを渡して
                // 名前に引き直す。渡さないと variables_get 側と食い違う
                const name = variableName(fieldValue(block, "SENTENCE"), block);
                for await (const sentence of ctx.api.replySentences(prompt)) {
                    ctx.variables.set(name, sentence);
                    await runStatements(inputBlock(block, "DO"), ctx);
                    await ctx.api.tick();
                }
            })();

        case "variables_set": {
            const name = variableName(fieldValue(block, "VAR"), block);
            return andThen(evaluate(inputBlock(block, "VALUE"), ctx), (value) => {
                ctx.variables.set(name, value);
            });
        }

        default:
            warnOnce(`知らないブロックです: ${blockType(block)}`);
            return undefined;
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
 * 変数は、すべての並びで共有する（Scratch と同じ）。入れ物は呼び出し側が
 * アプリ全体で 1 つ持ち、編集画面でクリックして試す実行（createStackAction）
 * にも同じものを渡す。いつ空に戻すかも呼び出し側が決める（app.js）
 *
 * @param {object} json Blockly のワークスペース形式
 * @param {object} [options]
 * @param {Map<string, *>} [options.variables] 変数の入れ物（名前 → 値）
 * @returns {{handlers: object, blockTypes: string[], warnings: string[]}}
 */
const createActionProgram = (json, {variables = new Map()} = {}) => {
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

    // イベント名 -> その帽子ブロックの下の並び（置いた順）
    const bodiesByEvent = new Map();

    for (const hat of json?.blocks?.blocks ?? []) {
        const eventType = EVENT_BLOCKS[hat?.type];
        if (! eventType) {
            // 帽子につながっていないブロックは、編集画面でクリックして
            // 単体で試すためのもの。置いてあるのが普通なので何も言わない
            // （イベント実行では動かないだけ）
            continue;
        }
        const body = hat.next?.block ?? null;
        collectBlockTypes(body, blockTypes);

        if (! bodiesByEvent.has(eventType)) {
            bodiesByEvent.set(eventType, []);
        }
        bodiesByEvent.get(eventType).push(body);
    }

    // 同じイベントの並びは、すべて同時に走らせる（Scratch と同じ）。
    // アクションが終わるのは、すべての並びが終わったとき（「ユーザの発話が
    // 決まったとき」の後に待機へ戻るのも、そのとき）。
    // 変数はすべての並びで共有する（上の説明を参照）。
    // 中断は api を通して全部の並びに同時に効く（同じ api を渡すため）。
    // 並びは置いた順に始め、それぞれ最初に処理を譲るところまで進んでから次の
    // 並びが始まる（Scratch と同じ）。async で包むのは、待たずに失敗した並びが
    // 例外をその場で投げても、残りの並びを始められるようにするため
    for (const [eventType, bodies] of bodiesByEvent) {
        handlers[eventType] = async (api, detail) => {
            const results = await Promise.allSettled(bodies.map(async (body) =>
                runStatements(body, {api, detail, variables})));
            // 1 本が失敗しても、ほかの並びは最後まで走らせる。失敗は、全部が
            // 終わってから知らせる（中断はそのまま、ほかの失敗は警告に回る）
            const failure = results.find((result) => result.status === "rejected");
            if (failure) {
                throw failure.reason;
            }
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
 * 変数は、イベントで動く並びと同じ入れ物を使う（createActionProgram を参照）
 *
 * @param {object} rootBlock 列の先頭にある生の Blockly ブロック
 * @param {object} [options]
 * @param {Map<string, *>} [options.variables] 変数の入れ物（名前 → 値）
 * @returns {(api: object) => Promise<void>}
 */
export const createStackAction = (rootBlock, {variables = new Map()} = {}) => {
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
        await runStatements(start, {api, detail: {}, variables});
    };
};

export default createActionProgram;
