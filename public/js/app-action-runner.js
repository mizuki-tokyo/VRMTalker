/**
 * イベントに対してアクションを走らせる。
 *
 * 実行の規則は 3 つだけ。ビジュアルプログラミングで組んだ人が
 * 「なぜこう動いたか」を説明できる範囲に絞ってある。
 *
 *   1. イベントごとに 1 本だけ走る。同じイベントが再び起きたら、前のアクションを
 *      中断してから新しいものを始める（Scratch のハットブロックと同じ）
 *   2. 別のイベントのアクションとは並行して走る
 *   3. 状態を表すイベント（idle など）のアクションは、その状態を抜けるときに中断する
 *
 * アクションの中で起きた例外は警告にとどめる。利用者の画面に実行時エラーを出さない。
 */

import {ActionStopped} from "./app-avatar-api.js";


/**
 * @param {object}   deps
 * @param {EventTarget} deps.conversation イベントの発生元
 * @param {(signal: AbortSignal) => object} deps.createApi
 *        アクションへ渡す API を作る。中断の合図を受け取る
 * @param {(type: string) => void} [deps.onSettled]
 *        アクションが終わったとき（成功・失敗・中断のいずれも）
 */
const createActionRunner = ({conversation, createApi, onSettled = () => {}}) => {

    // イベント名 -> 実行中のアクションの中断用
    const running = new Map();

    const abort = (type) => {
        const controller = running.get(type);
        if (controller) {
            controller.abort();
            running.delete(type);
        }
    };

    const run = async (type, handler, detail) => {
        // 規則 1: 同じイベントの前のアクションを中断してから始める
        abort(type);

        const controller = new AbortController();
        running.set(type, controller);

        try {
            await handler(createApi(controller.signal), detail ?? {});
        } catch (error) {
            if (! (error instanceof ActionStopped)) {
                console.warn(`アクション "${type}" でエラーが起きました`, error);
            }
        } finally {
            // 既に次のアクションが始まっていたら、その管理を消さない
            if (running.get(type) === controller) {
                running.delete(type);
            }
            onSettled(type);
        }
    };

    return {
        /**
         * イベントにアクションを登録する。
         * @param {string} type
         * @param {(api: object, detail: object) => Promise<void>} handler
         */
        on(type, handler) {
            if (typeof handler !== "function") {
                return;
            }
            conversation.addEventListener(type, (event) => {
                run(type, handler, event.detail);
            });
        },

        /**
         * 規則 3。状態を表すイベントのアクションを、別のイベントで中断する。
         *
         *   runner.cancelOn("idle", "listenstart");
         *
         * これが無いと、待機中の「ずっと」が会話中も回り続ける
         */
        cancelOn(type, endType) {
            conversation.addEventListener(endType, () => abort(type));
        },

        /** 実行中のアクションを全部止める。 */
        abortAll() {
            for (const type of [...running.keys()]) {
                abort(type);
            }
        }
    };
};

export default createActionRunner;
