/**
 * 会話の節目で、アバターが何をするか。
 *
 * このファイルだけを書き換えれば、アバターの振る舞いを変えられる。
 * 対話の仕組み（音声認識・応答生成・音声合成）には手を触れなくてよい。
 *
 * イベントの一覧は app-conversation.js、使える関数は app-avatar-api.js を参照。
 *
 * 書き方の決まり
 *   - 各関数は (api, detail) を受け取る
 *   - 待ちたいところにだけ await を付ける。付けなければ並行して進む
 *   - 例外は書かなくてよい。失敗は api 側が警告にとどめる
 *   - 同じイベントがもう一度起きると、走っている途中でも中断される
 *
 * 将来はこの内容をビジュアルプログラミングで組み、JSON として保存・読込できる
 * ようにする。そのため、ここで使う関数は api のものだけに限り、
 * avatar や document を直接触らないこと。
 */

import {SPEAKER} from "./app-avatar-api.js";


export default {

    /** 準備ができた（モデルの読み込み完了）。一度だけ。 */
    ready: async (api) => {
        await api.speakAndWait(`こんにちは。わたしは${api.characterName()}です。`);
        api.showBubble(SPEAKER.character, "マイクのボタンを押して話しかけてください。");
    },

    /** 入力待ちに入った。会話が始まると中断される。 */
    idle: async (api) => {
        // 待機中の仕草をここに書く。例えば数秒おきに小さく表情を動かす

        // while (true) {
        //     await api.wait(api.random(5, 15));
        //     if (api.random(1, 100) <= 30) {
        //         await api.playMotionAndWait("おじぎ");
        //     }
        // }

    },

    /** 音声認識が始まった。 */
    listenstart: async (api) => {
        // 聞く姿勢をここに書く
        //await api.playMotionAndWait("おじぎ");
    },

    /** ユーザが話し始めた。音声認識の実装によっては呼ばれない。 */
    speechstart: async (api) => {
    },

    /** ユーザが話し終わった。音声認識の実装によっては呼ばれない。 */
    speechend: async (api) => {
    },

    /**
     * 発話が確定した。会話の本体。
     *
     * ユーザの発話を吹き出しに出すのはアプリ側が済ませてある。
     * ここでは返事の組み立て方だけを書く
     */
    listenend: async (api, {text}) => {
        // 返事を待つ間もアバターを動かしておく。await を付けないので並行して進む。
        // モーション名は animations/motions.json で決める
        api.playMotion("手を挙げる");
        api.changeExpression("happy", 1.0, 0.3);

        // 返事は文が完成した順に届く。全部できあがるのを待たずに話し始められる
        for await (const sentence of api.replySentences(text)) {
            api.showBubble(SPEAKER.character, sentence);
            await api.speakAndWait(sentence);
        }

        // 話し終わったら表情を戻す
        await api.changeExpressionAndWait("happy", 0, 0.5);
    },

    /** どこかで失敗した。phase は "recognize" | "chat" | "speak"。 */
    error: async (api, {phase, message}) => {
        api.showBubble(SPEAKER.character, message);
        await api.playVoiceAndWait("error-occurred");
    }
};
