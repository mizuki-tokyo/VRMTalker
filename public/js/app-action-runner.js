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

    // イベント名 -> 今のアクション。編集画面で保存すると差し替わる
    const handlers = new Map();

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
         *
         * 同じイベントに登録し直すと差し替わる（購読は二重にならない）。
         * 編集画面で保存したとき、リロードせずに新しい動作へ移れるようにするため
         *
         * @param {string} type
         * @param {(api: object, detail: object) => Promise<void>} handler
         */
        on(type, handler) {
            if (typeof handler !== "function") {
                return;
            }
            const isFirst = ! handlers.has(type);
            handlers.set(type, handler);

            if (isFirst) {
                conversation.addEventListener(type, (event) => {
                    // 登録し直されている場合があるので、そのつど引き直す
                    const current = handlers.get(type);
                    if (current) {
                        run(type, current, event.detail);
                    }
                });
            }
        },

        /** 登録を消す。差し替え後に消えたイベントを残さないために使う。 */
        off(type) {
            abort(type);
            handlers.delete(type);
        },

        /** 登録済みのイベント名。 */
        get types() {
            return [...handlers.keys()];
        },

        /**
         * イベントに紐づかない単発の実行。編集画面でブロックをクリックしたとき。
         *
         * 規則 1 はそのまま効く。同じ key で呼び直すと前のものを中断してから
         * 始まる。key はイベント名と重ならないものにすること（重ねると
         * onSettled がイベント側の後始末を呼んでしまう）
         *
         * @param {string} key
         * @param {(api: object) => Promise<void>} handler
         * @returns {Promise<void>} 終わった（中断も含む）時点で解決する
         */
        runOnce(key, handler) {
            return run(key, handler, {});
        },

        /** 実行中かどうか。クリックが「開始」か「停止」かの判定に使う。 */
        isRunning(key) {
            return running.has(key);
        },

        /** 指定したものだけ止める。 */
        abort(key) {
            abort(key);
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
