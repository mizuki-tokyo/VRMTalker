/**
 * 編集画面で、つまずきやすい組み方に警告のマークを付ける。
 *
 * ブロックの左上に「！」のマークが付き、押すと説明が出る（Blockly の
 * setWarningText）。動きは止めない。知らせるだけ。
 *
 *   const warnings = createBlockWarnings(workspace);
 *   warnings.update();   // ブロックを置く・動かす・消すたびに呼ぶ
 *
 * 調べること
 *   1. 返事のブロックが、同じイベントの複数の並びにある
 *      同じイベントの並びは同時に動くので、返事が 2 回になり、声も重なる。
 *      変数も共有なので、一文ずつのくりかえしの変数に入る文が入り混じる
 *   2. 「ユーザの発話が決まったとき」の並びに「ずっと」がある
 *      並びが終わらないので、会話が待機に戻らず、「待機に入ったとき」が
 *      動かない。連続対話では、次の発話を聞かなくなる
 *   3. 「返事を一文ずつ〜くりかえす」の前に「〜への返事を考える」が無い
 *      取り出す返事が無いので、何もしない（前の返事が残っていれば、それを
 *      もう一度たどる）
 */

import {EVENT_BLOCKS} from "./app-action-program.js";

/** 返事を頼むブロック。 */
const REPLY_BLOCKS = new Set(["chat_reply", "chat_reply_each_sentence", "chat_think_reply"]);

/**
 * 警告の種類（setWarningText の id）と文。
 *
 * 吹き出しは自動では折り返さない（1 行のまま横に伸びる）ので、行は自分で分ける
 */
const WARNINGS = Object.freeze({
    duplicateReply: {
        id: "duplicate-reply",
        text: [
            "返事のブロックが、同じきっかけの",
            "別の並びにもあります。",
            "",
            "同じきっかけの並びは同時に動くので、",
            "返事が 2 回になり、声も重なります。",
            "返事は 1 つの並びにまとめてください。"
        ].join("\n")
    },
    foreverInListenend: {
        id: "forever-in-listenend",
        text: [
            "「ユーザの発話が決まったとき」の中の",
            "「ずっと」は終わりません。",
            "",
            "会話が待機に戻らず、",
            "「待機に入ったとき」が動かなくなります。",
            "連続対話では、次の発話を聞かなくなります。"
        ].join("\n")
    },
    eachWithoutThink: {
        id: "each-without-think",
        text: [
            "この前に「〜への返事を考える」がありません。",
            "",
            "取り出す返事が無いので、何もしません。",
            "同じ並びの、このブロックより上に",
            "「〜への返事を考える」を置いてください。"
        ].join("\n")
    }
});

/**
 * 並びの中で、block より前に実行されるブロックに type があるか。
 *
 * 「前」は、block から上へ（つながった前のブロックへ）たどり、包んでいる
 * ブロック（「もし」「くりかえす」など）の中ではその前も見る。包んでいる
 * ブロックの条件の中は見ない（返事を考えるブロックは条件に入らない）
 */
const hasEarlier = (block, type) => {
    for (let current = block; current; current = current.getSurroundParent()) {
        const surround = current.getSurroundParent();
        for (let previous = current.getPreviousBlock(); previous && previous !== surround;
             previous = previous.getPreviousBlock()) {
            // 包んでいるブロックの中の先頭では、getPreviousBlock() が包んでいる
            // ブロックそのものを返すので、そこで止める（ループの条件）
            if (containsType(previous, type)) {
                return true;
            }
        }
    }
    return false;
};

/**
 * block そのものか、その中（差し込み口・C 型の口）に type があるか。
 * 後ろにつながったブロックは見ない（getDescendants は後ろまで含むので使わない）
 */
const containsType = (block, type) =>
      block.type === type
      || block.inputList.some((input) => input.connection?.targetBlock()
          ?.getDescendants(false).some((inner) => inner.type === type));


/**
 * @param {object} workspace Blockly のワークスペース
 */
export const createBlockWarnings = (workspace) => {

    // 付けてある警告。ブロックの id -> Map(警告の id -> 文)。
    // 変わったところだけ付け外しするために覚えておく
    let applied = new Map();

    /** 今の組み方から、付けるべき警告を求める。 */
    const collect = () => {
        const wanted = new Map();
        const add = (block, warning) => {
            if (! wanted.has(block.id)) {
                wanted.set(block.id, new Map());
            }
            wanted.get(block.id).set(warning.id, warning.text);
        };

        // イベント名 -> 返事のブロックを含む並びごとの、返事のブロックの並び
        const replyStacks = new Map();

        for (const hat of workspace.getTopBlocks(false)) {
            const eventType = EVENT_BLOCKS[hat.type];
            if (! eventType) {
                continue;
            }
            const descendants = hat.getDescendants(false);

            const replies = descendants.filter((block) => REPLY_BLOCKS.has(block.type));
            if (replies.length > 0) {
                if (! replyStacks.has(eventType)) {
                    replyStacks.set(eventType, []);
                }
                replyStacks.get(eventType).push(replies);
            }

            if (eventType === "listenend") {
                for (const block of descendants) {
                    if (block.type === "control_forever") {
                        add(block, WARNINGS.foreverInListenend);
                    }
                }
            }
        }

        // 2 本以上の並びに返事があれば、どの並びの返事にも付ける
        // （どこにあるのかを両方とも見せる）
        for (const stacks of replyStacks.values()) {
            if (stacks.length >= 2) {
                for (const block of stacks.flat()) {
                    add(block, WARNINGS.duplicateReply);
                }
            }
        }

        // 「返事を一文ずつ〜くりかえす」の前に「返事を考える」が無い。
        // 帽子の無い並び（試しに動かすためのもの）も見る
        for (const block of workspace.getAllBlocks(false)) {
            if (block.type === "chat_each_reply_sentence"
                && ! hasEarlier(block, "chat_think_reply")) {
                add(block, WARNINGS.eachWithoutThink);
            }
        }
        return wanted;
    };

    /** 警告を付け直す。変わったところだけ付け外しする。 */
    const update = () => {
        const wanted = collect();

        // 要らなくなった警告を外す
        for (const [blockId, warnings] of applied) {
            const block = workspace.getBlockById(blockId);
            for (const warningId of warnings.keys()) {
                if (! wanted.get(blockId)?.has(warningId)) {
                    block?.setWarningText(null, warningId);
                }
            }
        }
        // 新しく要る警告を付ける
        for (const [blockId, warnings] of wanted) {
            const block = workspace.getBlockById(blockId);
            for (const [warningId, text] of warnings) {
                if (applied.get(blockId)?.get(warningId) !== text) {
                    block?.setWarningText(text, warningId);
                }
            }
        }
        applied = wanted;
    };

    return {update};
};

export default createBlockWarnings;
