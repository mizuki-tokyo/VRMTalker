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

/**
 * 視線を向ける先。画面から見た向きで書く（アバターから見た左右ではない）。
 * 向きの符号は <vrm-avatar> の gazeTo() が吸収する
 */
const GAZE_DIRECTIONS = [
    ["右", "right"], ["左", "left"], ["上", "up"], ["下", "down"], ["正面", "front"]
];

/**
 * 視線を動かす量。
 *
 * 度数で書かせない。VRM の視線はモデル側の範囲へ圧縮されるため、45 度と
 * 指定しても目が動くのは 7 度ほどで、しかもモデルごとに違う。数字を見せると
 * 「45 度にしたのに動かない」という誤解になる
 */
const GAZE_AMOUNTS = [["ちらっと", "20"], ["しっかり", "60"]];

/**
 * ジェスチャーをする手。アバター自身から見た左右（画面では逆に見える）。
 * 利き手の多い右手を先に置く（ドロップダウンの既定になる）
 */
const HANDS = [["右手", "right"], ["左手", "left"]];

/**
 * 「現在の〇〇」の項目。覚える値は app-avatar-api.js の currentTime() と合わせる。
 * 「日」は月の中の何日か（曜日の「日」とは別）
 */
const TIME_UNITS = [
    ["年", "year"], ["月", "month"], ["日", "date"], ["曜日", "day-of-week"],
    ["時", "hour"], ["分", "minute"], ["秒", "second"]
];

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
const buildBlockUi = ({motionChoices = [], poseChoices = [], gestureChoices = [],
                       emoteChoices = [], soundChoices = [],
                       backgroundChoices = [], voiceChoices = []} = {}) => {
    /*
      ドロップダウンは「出す文字（name）」と「覚える値（id）」を分けて持つ。
      名前は画面に出す文字なので後から直したくなるが、直したときに保存済みの
      アクションの選択が外れないようにするため。

      読み込みが終わる前に編集画面を開くと空になる。選べないことが伝わる
      見出しを 1 つ出しておく（空のドロップダウンは Blockly が嫌う）
    */
    const choices = (items, empty) =>
          (items.length > 0) ? items.map((item) => [item.name, item.id]) : [[empty, ""]];

    const motions = choices(motionChoices, "（モーションがありません）");
    const poses = choices(poseChoices, "（ポーズがありません）");
    const gestures = choices(gestureChoices, "（ジェスチャーがありません）");
    const emotes = choices(emoteChoices, "（エモートがありません）");
    const sounds = choices(soundChoices, "（効果音がありません）");
    const backgrounds = choices(backgroundChoices, "（背景がありません）");
    const voices = choices(voiceChoices, "（ボイスデータがありません）");

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
        avatar_play_voice: {
            message0: "ボイスデータ %1 を再生する",
            args0: [dropdown("VOICE", voices)], style: "sound_blocks",
            tooltip: "録っておいた声を、アバターが口を動かして喋る。終わるのを待たない。"
                   + "鳴らせるものは voices/voices.json で決める"
        },
        avatar_play_voice_wait: {
            message0: "ボイスデータ %1 を再生して終わるまで待つ",
            args0: [dropdown("VOICE", voices)], style: "sound_blocks"
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
        avatar_take_pose: {
            message0: "%1 のポーズをとる",
            args0: [dropdown("NAME", poses)], style: "motion_blocks",
            tooltip: "全身の姿勢を変えて、次の指示までそのまま保つ。待機モーションの代わりに"
                   + "なり、モーションを再生し終えるとこのポーズへ戻る。"
                   + "選べるポーズは animations/poses.json で決める"
        },
        avatar_take_pose_for: {
            message0: "%1 のポーズを %2 秒とる",
            args0: [dropdown("NAME", poses), number("SECONDS")],
            style: "motion_blocks", inputsInline: true,
            tooltip: "秒数がたったら待機モーションへ戻る。戻るのを待たない"
        },
        avatar_take_pose_for_wait: {
            message0: "%1 のポーズを %2 秒とって終わるまで待つ",
            args0: [dropdown("NAME", poses), number("SECONDS")],
            style: "motion_blocks", inputsInline: true
        },
        avatar_stop_pose: {
            message0: "ポーズをやめる", args0: [], style: "motion_blocks",
            tooltip: "待機モーションへ戻る"
        },
        avatar_play_gesture: {
            message0: "%1 で %2 のジェスチャーを %3 秒する",
            args0: [dropdown("HAND", HANDS), dropdown("NAME", gestures), number("SECONDS")],
            style: "motion_blocks", inputsInline: true,
            tooltip: "腕と手だけの身ぶり。モーションやポーズの上から重ねる。"
                   + "右手・左手はアバターから見たほうで、画面では逆に見える。"
                   + "戻るのを待たない。選べるものは animations/gestures.json で決める"
        },
        avatar_play_gesture_wait: {
            message0: "%1 で %2 のジェスチャーを %3 秒して終わるまで待つ",
            args0: [dropdown("HAND", HANDS), dropdown("NAME", gestures), number("SECONDS")],
            style: "motion_blocks", inputsInline: true
        },
        avatar_stop_gesture: {
            message0: "ジェスチャーをやめる", args0: [], style: "motion_blocks"
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
        avatar_clear_expression: {
            message0: "表情を消す", args0: [], style: "looks_blocks",
            tooltip: "出している表情をすべて消して、ふつうの顔に戻す。"
                   + "まばたきと口の形はそのまま"
        },
        avatar_look_at: {
            message0: "カメラを %1 に向ける",
            args0: [dropdown("BONE", BONES)], style: "motion_blocks",
            tooltip: "画面に映る位置を変える。アバターの視線ではない"
        },
        avatar_gaze_to: {
            message0: "視線を %1 に %2 向ける",
            args0: [dropdown("DIRECTION", GAZE_DIRECTIONS),
                    dropdown("DEGREES", GAZE_AMOUNTS)],
            style: "motion_blocks", inputsInline: true,
            tooltip: "動くのは目だけで、頭は回らない。向きは画面から見たほう。"
                   + "「正面」で真っすぐに戻る（カメラは追いかけない）"
        },
        avatar_gaze_camera: {
            message0: "視線をカメラに向ける", args0: [], style: "motion_blocks",
            tooltip: "一度だけ向けて、そこで止まる。カメラが動いても付いていかない"
        },
        avatar_gaze_follow: {
            message0: "視線をカメラに向けたままにする（はじめの状態）",
            args0: [], style: "motion_blocks",
            tooltip: "カメラを目で追いかける。動かした視線を元に戻すのもこれ"
        },
        avatar_show_emote: {
            message0: "%1 のエモートを %2 秒出す",
            args0: [dropdown("NAME", emotes), number("SECONDS")],
            style: "looks_blocks", inputsInline: true,
            tooltip: "頭の上にアイコンを出す。消えるのを待たない。"
                   + "出せる絵は emotes/emotes.json で決める"
        },
        avatar_show_emote_wait: {
            message0: "%1 のエモートを %2 秒出して消えるまで待つ",
            args0: [dropdown("NAME", emotes), number("SECONDS")],
            style: "looks_blocks", inputsInline: true
        },
        avatar_clear_emote: {
            message0: "エモートを消す", args0: [], style: "looks_blocks",
            tooltip: "0 秒で出したエモートを消すときに使う"
        },

        //-------------------------------- 効果音
        sound_play: {
            message0: "%1 の音を鳴らす",
            args0: [dropdown("NAME", sounds)], style: "sound_blocks",
            tooltip: "鳴り終わるのを待たない。続けて鳴らすと音が重なる。"
                   + "鳴らせる音は sounds/sounds.json で決める"
        },
        sound_play_wait: {
            message0: "%1 の音を鳴らして終わるまで待つ",
            args0: [dropdown("NAME", sounds)], style: "sound_blocks"
        },
        sound_stop: {
            message0: "音を止める", args0: [], style: "sound_blocks",
            tooltip: "鳴っている効果音を全部止める。話すのは止まらない"
        },

        //-------------------------------- 画面
        screen_show_bubble: {
            message0: "%1 の吹き出しに %2 を出す",
            args0: [dropdown("WHO", SPEAKERS), text("TEXT")],
            style: "looks_blocks", inputsInline: true
        },
        screen_clear_bubbles: {
            message0: "吹き出しを全部消す", args0: [], style: "looks_blocks",
            tooltip: "画面から消すだけ。キャラクタは前のやり取りを覚えたまま"
        },
        screen_show_toast: {
            message0: "%1 というメッセージを %2 秒間出す",
            args0: [text("TEXT"), number("SECONDS")],
            style: "looks_blocks", inputsInline: true,
            tooltip: "画面の真ん中に出して、時間が来たら消える。消えるのを待たない。"
                   + "吹き出しと違って会話の記録には残らない"
        },
        screen_set_background: {
            message0: "背景を %1 にする",
            args0: [dropdown("NAME", backgrounds)], style: "looks_blocks",
            tooltip: "選べる背景は backgrounds/backgrounds.json で決める"
        },

        //-------------------------------- 会話
        chat_reply: {
            message0: "%1 に返事をする",
            args0: [text("PROMPT")], style: "sensing_blocks",
            tooltip: "返事を考えて、吹き出しに出しながら話す"
        },
        chat_clear_history: {
            message0: "会話の記憶を消す", args0: [], style: "sensing_blocks",
            tooltip: "キャラクタが前のやり取りを覚えていない状態に戻す。"
                   + "吹き出しは消えない"
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
        // 曜日だけ文字（月〜日）、ほかは数を返すので、出力は「数か文字」にする。
        // 型を決めない（null）と、Zelos ではパズルのような形で描かれてしまう
        operator_current: {
            message0: "現在の %1",
            args0: [dropdown("UNIT", TIME_UNITS)],
            output: ["Number", "String"], style: "operator_blocks",
            tooltip: "パソコンの時計の今の値。曜日は「月」〜「日」の文字、"
                   + "ほかは数（月は 1〜12、時は 0〜23）。「日」は月の中の何日か"
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
 * @param {object}   names
 * ドロップダウンに出すものは、どれも {id, name} の並びで受け取る。
 * 画面には name を出し、アクションには id を覚えさせる。
 *
 * @param {Array<{id: string, name: string}>} names.motionChoices
 * @param {Array<{id: string, name: string}>} names.emoteChoices
 * @param {Array<{id: string, name: string}>} names.soundChoices
 * @param {Array<{id: string, name: string}>} names.backgroundChoices
 * @param {Array<{id: string, name: string}>} names.voiceChoices
 * @returns {string[]} 表とずれている箇所の警告
 */
export const defineBlocks = (Blockly, names = {}) => {
    const ui = buildBlockUi(names);
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

    // 条件分岐。Blockly 標準の controls_if は歯車で else if を足す作りで、
    // 形が Scratch と違って収まりが悪い。入力を固定した 2 種類を用意する。
    // 「でなければもし」が要るときは control_if_else を入れ子にする（Scratch と同じ）
    definitions.push({
        type: "control_if",
        message0: "もし %1 なら",
        args0: [{type: "input_value", name: "CONDITION", check: "Boolean"}],
        message1: "%1", args1: [{type: "input_statement", name: "DO"}],
        previousStatement: null, nextStatement: null,
        inputsInline: true, style: "control_blocks",
        tooltip: "条件が成り立つときだけ、中のブロックを動かします"
    });

    definitions.push({
        type: "control_if_else",
        message0: "もし %1 なら",
        args0: [{type: "input_value", name: "CONDITION", check: "Boolean"}],
        message1: "%1", args1: [{type: "input_statement", name: "DO"}],
        message2: "でなければ",
        message3: "%1", args3: [{type: "input_statement", name: "ELSE"}],
        previousStatement: null, nextStatement: null,
        inputsInline: true, style: "control_blocks",
        tooltip: "条件が成り立つかどうかで、動かすブロックを分けます"
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
                    {kind: "block", type: "avatar_take_pose"},
                    {kind: "block", type: "avatar_take_pose_for",
                     inputs: {SECONDS: shadowNumber(5)}},
                    {kind: "block", type: "avatar_take_pose_for_wait",
                     inputs: {SECONDS: shadowNumber(5)}},
                    {kind: "block", type: "avatar_stop_pose"},
                    {kind: "block", type: "avatar_play_gesture",
                     inputs: {SECONDS: shadowNumber(3)}},
                    {kind: "block", type: "avatar_play_gesture_wait",
                     inputs: {SECONDS: shadowNumber(3)}},
                    {kind: "block", type: "avatar_stop_gesture"},
                    {kind: "block", type: "avatar_set_expression",
                     inputs: {VALUE: shadowNumber(1)}},
                    {kind: "block", type: "avatar_change_expression",
                     inputs: {VALUE: shadowNumber(1), SECONDS: shadowNumber(0.3)}},
                    {kind: "block", type: "avatar_change_expression_wait",
                     inputs: {VALUE: shadowNumber(0), SECONDS: shadowNumber(0.5)}},
                    {kind: "block", type: "avatar_clear_expression"},
                    {kind: "block", type: "avatar_look_at"},
                    {kind: "block", type: "avatar_gaze_to"},
                    {kind: "block", type: "avatar_gaze_camera"},
                    {kind: "block", type: "avatar_gaze_follow"},
                    {kind: "block", type: "avatar_show_emote",
                     inputs: {SECONDS: shadowNumber(2)}},
                    {kind: "block", type: "avatar_show_emote_wait",
                     inputs: {SECONDS: shadowNumber(2)}},
                    {kind: "block", type: "avatar_clear_emote"},
                    {kind: "block", type: "avatar_play_voice"},
                    {kind: "block", type: "avatar_play_voice_wait"},
                    {kind: "block", type: "avatar_stop_speaking"}
                ]
            },
            {
                kind: "category", name: "音", categorystyle: "sound_category",
                contents: [
                    {kind: "block", type: "sound_play"},
                    {kind: "block", type: "sound_play_wait"},
                    {kind: "block", type: "sound_stop"}
                ]
            },
            {
                kind: "category", name: "画面", categorystyle: "looks_category",
                contents: [
                    {kind: "block", type: "screen_show_bubble",
                     inputs: {TEXT: shadowText("こんにちは")}},
                    {kind: "block", type: "screen_clear_bubbles"},
                    {kind: "block", type: "screen_show_toast",
                     inputs: {TEXT: shadowText("エラーが起きました"),
                              SECONDS: shadowNumber(3)}},
                    {kind: "block", type: "screen_set_background"}
                ]
            },
            {
                kind: "category", name: "会話", categorystyle: "sensing_category",
                contents: [
                    {kind: "block", type: "chat_reply_each_sentence",
                     inputs: {PROMPT: {block: {type: "value_user_text"}}}},
                    {kind: "block", type: "chat_reply",
                     inputs: {PROMPT: {block: {type: "value_user_text"}}}},
                    {kind: "block", type: "chat_clear_history"},
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
                    {kind: "block", type: "control_if"},
                    {kind: "block", type: "control_if_else"}
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
                    {kind: "block", type: "operator_current"},
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
