/**
 * ブロックの見た目と、ツールボックス（左のパレット）の定義。
 *
 * 「どのブロックがあるか」と「それが何を呼ぶか」は app-action-program.js の
 * 表が持っている。このファイルはそこに**見た目だけ**を足す。
 *
 *   app-action-program.js   ブロックの型 → api の関数と引数名（実行に必要）
 *   app-blocks.js           ブロックの型 → 文言・入力の形・色（編集に必要）
 *
 * 二重に持つと必ずずれるので、読み込み時に両方を突き合わせて警告を出す。
 * 表にあるのに見た目が無い／見た目があるのに表に無い、のどちらも検出する。
 *
 * このファイルは編集画面を開いたときにだけ読み込まれる（Blockly も同様）。
 */

import {CALL_BLOCKS, VALUE_BLOCKS, EVENT_BLOCKS, DETAIL_BLOCKS}
    from "./app-action-program.js";


/** 基本表情。モデルに依存せず使えることが分かっているものだけ並べる。 */
const EXPRESSIONS = [
    ["うれしい", "happy"],
    ["おこり", "angry"],
    ["かなしい", "sad"],
    ["リラックス", "relaxed"],
    ["おどろき", "surprised"],
    ["ふつう", "neutral"]
];

/** 注視点にできるボーン。VRM の仕様で必ず存在するものを選ぶ。 */
const BONES = [["頭", "head"], ["胸", "chest"], ["腰", "hips"]];

/** 吹き出しの出し手。app-avatar-api.js の SPEAKER と合わせる。 */
const SPEAKERS = [["キャラクタ", "キャラクタ"], ["あなた", "あなた"]];

/** 帽子ブロックの文言。 */
const EVENT_LABELS = Object.freeze({
    event_ready: "準備ができたとき",
    event_idle: "待機に入ったとき",
    event_listenstart: "聞き取りを始めたとき",
    event_speechstart: "ユーザが話し始めたとき",
    event_speechend: "ユーザが話し終わったとき",
    event_listenend: "ユーザの発話が決まったとき",
    event_error: "エラーが起きたとき"
});


/**
 * 文・値ブロックの見た目。
 *
 * args の名前は app-action-program.js の表と一致させること。
 * field_* はドロップダウン（保存時は fields に入る）、input_value は
 * 差し込み口（保存時は inputs に入る）。インタプリタはどちらでも読める
 */
const buildBlockUi = (motionNames) => {
    const motions = (motionNames.length > 0)
          ? motionNames.map((name) => [name, name])
          : [["（モーションがありません）", ""]];

    const text = (name) => ({type: "input_value", name});
    const number = (name) => ({type: "input_value", name, check: "Number"});
    const dropdown = (name, options) => ({type: "field_dropdown", name, options});

    return {
        //-------------------------------- アバター
        avatar_speak: {
            message0: "%1 と話す",
            args0: [text("TEXT")], style: "looks_blocks",
            tooltip: "音声合成して話す。話し終わるのを待たない"
        },
        avatar_speak_and_wait: {
            message0: "%1 と話して終わるまで待つ",
            args0: [text("TEXT")], style: "looks_blocks"
        },
        avatar_play_sound: {
            message0: "音声ファイル %1 を再生する",
            args0: [text("URL")], style: "sound_blocks"
        },
        avatar_play_sound_wait: {
            message0: "音声ファイル %1 を再生して終わるまで待つ",
            args0: [text("URL")], style: "sound_blocks"
        },
        avatar_stop_speaking: {
            message0: "話すのをやめる", args0: [], style: "sound_blocks"
        },
        avatar_play_motion: {
            message0: "%1 のモーションを再生する",
            args0: [dropdown("NAME", motions)], style: "motion_blocks",
            tooltip: "モーションは animations/motions.json で決める"
        },
        avatar_play_motion_wait: {
            message0: "%1 のモーションを再生して終わるまで待つ",
            args0: [dropdown("NAME", motions)], style: "motion_blocks"
        },
        avatar_set_expression: {
            message0: "表情 %1 を %2 にする",
            args0: [dropdown("NAME", EXPRESSIONS), number("VALUE")],
            style: "looks_blocks", inputsInline: true
        },
        avatar_change_expression: {
            message0: "表情 %1 を %2 に %3 秒で変える",
            args0: [dropdown("NAME", EXPRESSIONS), number("VALUE"), number("SECONDS")],
            style: "looks_blocks", inputsInline: true
        },
        avatar_change_expression_wait: {
            message0: "表情 %1 を %2 に %3 秒で変えて終わるまで待つ",
            args0: [dropdown("NAME", EXPRESSIONS), number("VALUE"), number("SECONDS")],
            style: "looks_blocks", inputsInline: true
        },
        avatar_look_at: {
            message0: "%1 を見る",
            args0: [dropdown("BONE", BONES)], style: "motion_blocks"
        },

        //-------------------------------- 画面
        screen_show_bubble: {
            message0: "%1 の吹き出しに %2 を出す",
            args0: [dropdown("WHO", SPEAKERS), text("TEXT")],
            style: "looks_blocks", inputsInline: true
        },
        screen_clear_bubbles: {
            message0: "吹き出しを全部消す", args0: [], style: "looks_blocks"
        },

        //-------------------------------- 会話
        chat_reply: {
            message0: "%1 に返事をする",
            args0: [text("PROMPT")], style: "sensing_blocks",
            tooltip: "返事を考えて、吹き出しに出しながら話す"
        },

        //-------------------------------- 制御
        control_wait: {
            message0: "%1 秒待つ", args0: [number("SECONDS")], style: "control_blocks"
        },

        //-------------------------------- 値
        value_user_text: {
            message0: "ユーザの発話", args0: [], output: "String", style: "sensing_blocks"
        },
        value_character_name: {
            message0: "キャラクタの名前", args0: [], output: "String", style: "sensing_blocks"
        },
        value_error_message: {
            message0: "エラーの内容", args0: [], output: "String", style: "sensing_blocks"
        },
        value_error_phase: {
            message0: "エラーの場所", args0: [], output: "String", style: "sensing_blocks"
        },
        operator_random: {
            message0: "%1 から %2 までの乱数",
            args0: [number("FROM"), number("TO")],
            output: "Number", inputsInline: true, style: "operator_blocks"
        },
        operator_includes: {
            message0: "%1 に %2 がふくまれる",
            args0: [text("TEXT"), text("WORD")],
            output: "Boolean", inputsInline: true, style: "operator_blocks"
        },
        // 入力 2 つの横長な結合。3 つ以上つなぎたいときは入力を増やせる
        // text_join を使う（そちらは縦に積まれる）
        operator_join: {
            message0: "%1 と %2",
            args0: [text("STRING1"), text("STRING2")],
            output: "String", inputsInline: true, style: "operator_blocks",
            tooltip: "2 つの文字をつなげる。入れ子にすれば 3 つ以上もつなげる"
        }
    };
};


/** 表と見た目がずれていないかを調べる。ずれたら必ず片方が動かなくなる。 */
const checkAgainstTables = (ui) => {
    const warnings = [];
    // detail から読むブロックは引数を取らないので、存在の確認だけに使う
    const known = {...CALL_BLOCKS, ...VALUE_BLOCKS};
    const detailOnly = Object.keys(DETAIL_BLOCKS);

    for (const [type, spec] of Object.entries(ui)) {
        if (detailOnly.includes(type)) {
            continue;
        }
        const entry = known[type];
        if (! entry) {
            warnings.push(`ブロック "${type}" は見た目だけ定義されています`
                          + `（app-action-program.js の表にありません）`);
            continue;
        }
        const uiArgs = (spec.args0 ?? []).map((a) => a.name);
        const missing = entry.args.filter((name) => ! uiArgs.includes(name));
        if (missing.length > 0) {
            warnings.push(`ブロック "${type}" の入力が足りません: ${missing.join(", ")}`);
        }
    }
    for (const type of [...Object.keys(known), ...detailOnly]) {
        if (! ui[type]) {
            warnings.push(`ブロック "${type}" は表にありますが、見た目が定義されていません`);
        }
    }
    for (const type of Object.keys(EVENT_BLOCKS)) {
        if (! EVENT_LABELS[type]) {
            warnings.push(`イベント "${type}" の文言が定義されていません`);
        }
    }
    return warnings;
};


/**
 * Blockly にブロックを登録する。
 *
 * @param {object} Blockly
 * @param {string[]} motionNames ドロップダウンに出すモーション名
 * @returns {string[]} 表とずれている箇所の警告
 */
export const defineBlocks = (Blockly, motionNames = []) => {
    const ui = buildBlockUi(motionNames);
    const definitions = [];

    // 帽子ブロック。下にだけつながる
    for (const [type, label] of Object.entries(EVENT_LABELS)) {
        definitions.push({
            type, message0: label, nextStatement: null, style: "event_blocks",
            tooltip: "この下につないだブロックが、そのときに動きます"
        });
    }

    for (const [type, spec] of Object.entries(ui)) {
        const definition = {type, ...spec};
        if (spec.output) {
            // 値ブロックは上下につながらない
        } else {
            definition.previousStatement = null;
            definition.nextStatement = null;
        }
        definitions.push(definition);
    }

    // 応答のループ。コの字型で、中に返事 1 文ぶんの処理を書く
    definitions.push({
        type: "chat_reply_each_sentence",
        message0: "%1 への返事を一文ずつ %2 に入れてくりかえす",
        args0: [
            {type: "input_value", name: "PROMPT"},
            {type: "field_variable", name: "SENTENCE", variable: "文"}
        ],
        message1: "%1",
        args1: [{type: "input_statement", name: "DO"}],
        previousStatement: null, nextStatement: null, style: "sensing_blocks",
        tooltip: "返事は文ができた順に届きます。全部できあがるのを待ちません"
    });

    definitions.push({
        type: "control_repeat",
        message0: "%1 回くりかえす",
        args0: [{type: "input_value", name: "TIMES", check: "Number"}],
        message1: "%1", args1: [{type: "input_statement", name: "DO"}],
        previousStatement: null, nextStatement: null, style: "control_blocks"
    });

    definitions.push({
        type: "control_forever",
        message0: "ずっと",
        message1: "%1", args1: [{type: "input_statement", name: "DO"}],
        previousStatement: null, style: "control_blocks",
        tooltip: "待機中のしぐさなどに使います。会話が始まると止まります"
    });

    Blockly.defineBlocksWithJsonArray(definitions);
    return checkAgainstTables(ui);
};


/** 左のパレット。 */
export const createToolbox = () => {
    const shadowText = (value) => ({shadow: {type: "text", fields: {TEXT: value}}});
    const shadowNumber = (value) => ({shadow: {type: "math_number", fields: {NUM: value}}});

    return {
        kind: "categoryToolbox",
        contents: [
            {
                kind: "category", name: "イベント", categorystyle: "event_category",
                contents: Object.keys(EVENT_LABELS).map((type) => ({kind: "block", type}))
            },
            {
                kind: "category", name: "アバター", categorystyle: "looks_category",
                contents: [
                    {kind: "block", type: "avatar_speak",
                     inputs: {TEXT: shadowText("こんにちは")}},
                    {kind: "block", type: "avatar_speak_and_wait",
                     inputs: {TEXT: shadowText("こんにちは")}},
                    {kind: "block", type: "avatar_play_motion"},
                    {kind: "block", type: "avatar_play_motion_wait"},
                    {kind: "block", type: "avatar_set_expression",
                     inputs: {VALUE: shadowNumber(1)}},
                    {kind: "block", type: "avatar_change_expression",
                     inputs: {VALUE: shadowNumber(1), SECONDS: shadowNumber(0.3)}},
                    {kind: "block", type: "avatar_change_expression_wait",
                     inputs: {VALUE: shadowNumber(0), SECONDS: shadowNumber(0.5)}},
                    {kind: "block", type: "avatar_look_at"},
                    {kind: "block", type: "avatar_play_sound",
                     inputs: {URL: shadowText("./mp3/konnichiwa.mp3")}},
                    {kind: "block", type: "avatar_play_sound_wait",
                     inputs: {URL: shadowText("./mp3/konnichiwa.mp3")}},
                    {kind: "block", type: "avatar_stop_speaking"}
                ]
            },
            {
                kind: "category", name: "画面", categorystyle: "looks_category",
                contents: [
                    {kind: "block", type: "screen_show_bubble",
                     inputs: {TEXT: shadowText("こんにちは")}},
                    {kind: "block", type: "screen_clear_bubbles"}
                ]
            },
            {
                kind: "category", name: "会話", categorystyle: "sensing_category",
                contents: [
                    {kind: "block", type: "chat_reply_each_sentence",
                     inputs: {PROMPT: {block: {type: "value_user_text"}}}},
                    {kind: "block", type: "chat_reply",
                     inputs: {PROMPT: {block: {type: "value_user_text"}}}},
                    {kind: "block", type: "value_user_text"},
                    {kind: "block", type: "value_character_name"},
                    {kind: "block", type: "value_error_message"},
                    {kind: "block", type: "value_error_phase"}
                ]
            },
            {
                kind: "category", name: "制御", categorystyle: "control_category",
                contents: [
                    {kind: "block", type: "control_wait",
                     inputs: {SECONDS: shadowNumber(1)}},
                    {kind: "block", type: "control_repeat",
                     inputs: {TIMES: shadowNumber(3)}},
                    {kind: "block", type: "control_forever"},
                    {kind: "block", type: "controls_if"}
                ]
            },
            {
                kind: "category", name: "演算", categorystyle: "operator_category",
                contents: [
                    {kind: "block", type: "math_number", fields: {NUM: 0}},
                    {kind: "block", type: "math_arithmetic",
                     inputs: {A: shadowNumber(1), B: shadowNumber(1)}},
                    {kind: "block", type: "operator_random",
                     inputs: {FROM: shadowNumber(1), TO: shadowNumber(10)}},
                    {kind: "block", type: "text", fields: {TEXT: ""}},
                    // 初期値は、つないだ結果が 1 つの語になるものを選ぶ。
                    // 「こんにちは」＋「さん」のように結果が意味をなさないと、
                    // このブロックが何をするのか値から読み取れない。
                    // 入力の数を増やせるのが text_join の取り柄なので、
                    // そちらは 3 つにして並べたときの違いを見せる
                    {kind: "block", type: "operator_join",
                     inputs: {STRING1: shadowText("おはよう"),
                              STRING2: shadowText("ございます")}},
                    {kind: "block", type: "text_join",
                     extraState: {itemCount: 3},
                     inputs: {ADD0: shadowText("きょうは"),
                              ADD1: shadowText("いい"),
                              ADD2: shadowText("天気")}},
                    {kind: "block", type: "operator_includes",
                     inputs: {TEXT: {block: {type: "value_user_text"}},
                              WORD: shadowText("ありがとう")}},
                    {kind: "block", type: "logic_compare",
                     inputs: {A: shadowNumber(0), B: shadowNumber(0)}},
                    {kind: "block", type: "logic_operation"},
                    {kind: "block", type: "logic_negate"},
                    {kind: "block", type: "logic_boolean"}
                ]
            },
            {
                kind: "category", name: "変数", categorystyle: "variable_category",
                custom: "VARIABLE"
            }
        ]
    };
};
