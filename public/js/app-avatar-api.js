/**
 * アクションから呼べる関数。
 *
 * ここにある関数が、そのままビジュアルプログラミングのブロック 1 個になる。
 * そのため次の制約を守ること。
 *
 *   - 引数はプリミティブだけ（文字列・数値・真偽）。オブジェクトを受け取らない
 *   - 1 関数 = 1 ブロック。オプションの入れ物（{a, b}）を使わない
 *   - 例外を投げない。失敗は警告を出して続ける（利用者の画面を壊さない）
 *   - 「終わるまで待つ」版は関数名を分ける（…AndWait）
 *
 * 中断だけは例外で伝える。アクションの実行を途中で止める唯一の手段であり、
 * 呼び出し側（app-action-runner.js）が握りつぶすため、利用者には見えない。
 */

/** 中断を伝えるための専用の例外。実行時エラーと区別する。 */
export class ActionStopped extends Error {
    constructor() {
        super("アクションが中断されました");
        this.name = "ActionStopped";
    }
}

/** 吹き出しの出し手。ブロックのドロップダウンの選択肢になる */
export const SPEAKER = Object.freeze({
    character: "キャラクタ",
    user: "あなた"
});


/**
 * @param {object} deps
 * @param {Element}     deps.avatar            <vrm-avatar>
 * @param {Element}     deps.emote             <vrm-emote>
 * @param {Element}     deps.chatFlow          <chat-flow>
 * @param {object}      deps.speechSynthesizer SpeechSynthesizer
 * @param {object}      deps.sounds            SoundPlayer
 * @param {object}      deps.background        Background
 * @param {object}      deps.toast             画面に短い知らせを出すもの
 * @param {object}      deps.conversation      Conversation
 * @param {AbortSignal} deps.signal            中断の合図
 */
const createAvatarApi = ({avatar, emote, chatFlow, speechSynthesizer, sounds,
                          background, toast, conversation, signal}) => {

    const stopIfAborted = () => {
        if (signal.aborted) {
            throw new ActionStopped();
        }
    };

    // 中断されたら音も止める。何も鳴っていなければ何も起きない。
    // 止めないと、ブロックを止めたのに声や効果音だけが続く
    signal.addEventListener("abort", () => {
        avatar.stopSpeaking();
        sounds.stop();
    }, {once: true});

    /** 中断できる sleep。 */
    const sleep = (ms) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new ActionStopped());
        };
        signal.addEventListener("abort", onAbort, {once: true});
    });

    /** 失敗しても止まらないようにする。中断だけはそのまま投げ直す。 */
    const guard = async (work, what) => {
        try {
            return await work();
        } catch (error) {
            if (error instanceof ActionStopped) {
                throw error;
            }
            console.warn(`${what}に失敗しました`, error);
            return undefined;
        }
    };

    const speakText = async (text) => {
        const arrayBuffer = await speechSynthesizer.createSound(String(text));
        stopIfAborted();
        await avatar.speak(arrayBuffer);
    };

    const api = {

        //---------------------------------- アバター

        /** 話す。話し終わるのを待たない。 */
        speak(text) {
            guard(() => speakText(text), "発話").catch(() => {});
        },

        /** 話して、話し終わるまで待つ。 */
        async speakAndWait(text) {
            stopIfAborted();
            await guard(() => speakText(text), "発話");
        },

        /** 音声ファイルを再生する。終わるのを待たない。 */
        playSound(url) {
            guard(() => avatar.speak(String(url)), "音声の再生").catch(() => {});
        },

        /** 音声ファイルを再生して、終わるまで待つ。 */
        async playSoundAndWait(url) {
            stopIfAborted();
            await guard(() => avatar.speak(String(url)), "音声の再生");
        },

        /** 話している音声を止める。 */
        stopSpeaking() {
            avatar.stopSpeaking();
        },

        /** モーションを再生する。終わるのを待たない。 */
        playMotion(name) {
            guard(() => avatar.playMotion(String(name)), "モーションの再生").catch(() => {});
        },

        /** モーションを再生して、終わるまで待つ。 */
        async playMotionAndWait(name) {
            stopIfAborted();
            await guard(() => avatar.playMotion(String(name)), "モーションの再生");
        },

        /** 表情を即座に変える。value は 0-1。 */
        setExpression(name, value) {
            avatar.setExpression(String(name), Number(value));
        },

        /** 表情を徐々に変える。変わり切るのを待たない。 */
        changeExpression(name, value, seconds) {
            guard(() => avatar.tweenExpression(String(name), Number(value), Number(seconds)),
                  "表情の変更").catch(() => {});
        },

        /** 表情を徐々に変えて、変わり切るまで待つ。 */
        async changeExpressionAndWait(name, value, seconds) {
            stopIfAborted();
            await guard(
                () => avatar.tweenExpression(String(name), Number(value), Number(seconds)),
                "表情の変更");
        },

        /**
         * 表情を全部消して、ふつうの顔に戻す。
         *
         * 出した表情を 1 つずつ 0 に戻さなくてよいようにするもの。
         * まばたきと口の形は消えない（会話を続けられる）
         */
        clearExpression() {
            avatar.clearExpressions();
        },

        /** カメラの注視点をボーンに合わせる。 */
        lookAt(boneName) {
            avatar.focusCamera(String(boneName));
        },

        /**
         * 頭の上に感情アイコンを出す。消えるのを待たない。
         *
         * 話しながらアイコンを出す使い方が主なので、こちらが既定。
         * seconds が 0 以下なら clearEmote() を呼ぶまで出したままにする
         */
        showEmote(name, seconds) {
            guard(() => emote.show(String(name), Number(seconds)), "エモートの表示")
                .catch(() => {});
        },

        /** 感情アイコンを出して、消えるまで待つ。 */
        async showEmoteAndWait(name, seconds) {
            stopIfAborted();
            await guard(() => emote.show(String(name), Number(seconds)), "エモートの表示");
        },

        /** 感情アイコンを消す。 */
        clearEmote() {
            guard(() => emote.clear(), "エモートの消去").catch(() => {});
        },

        //---------------------------------- 効果音

        /**
         * 効果音を鳴らす。鳴り終わるのを待たない。
         *
         * 鳴らすたびに新しい再生が始まるので、続けて呼べば重なって鳴る。
         * 発話とは別系統で、互いに止め合わない
         */
        playSoundEffect(name) {
            sounds.play(String(name));
        },

        /** 効果音を鳴らして、鳴り終わるまで待つ。 */
        async playSoundEffectAndWait(name) {
            stopIfAborted();
            await guard(() => sounds.playAndWait(String(name)), "効果音の再生");
        },

        /** 鳴っている効果音を全部止める。発話は止まらない。 */
        stopSoundEffects() {
            sounds.stop();
        },

        //---------------------------------- 画面

        /** 吹き出しを出す。who は SPEAKER の値。 */
        showBubble(who, text) {
            chatFlow.appendMessage(String(text), (who === SPEAKER.user) ? "right" : "left");
        },

        /**
         * 吹き出しを全部消す。画面から消すだけで、キャラクタは前のやり取りを
         * 覚えたまま。忘れさせたいときは clearHistory() を使う
         */
        clearBubbles() {
            chatFlow.clearMessages();
        },

        /**
         * 画面にメッセージを出す。消えるのを待たない。
         *
         * 吹き出しと違って会話の記録には残らない。エラーの知らせなど、
         * キャラクタの発言ではないものに使う
         */
        showToast(text, seconds) {
            toast.show(String(text), Number(seconds));
        },

        /**
         * 背景の絵を替える。
         *
         * 絵を読み込めた時点で替わる。待たないので、続けて書いたブロックは
         * 替わる前に動き出す（替わるまで待つ必要がある使い方は想定していない）
         */
        setBackground(name) {
            guard(() => background.set(String(name)), "背景の変更").catch(() => {});
        },

        //---------------------------------- 会話

        /**
         * キャラクタに前のやり取りを忘れさせる。画面の吹き出しは残る。
         *
         * 「見た目を消す」と「記憶を消す」は別の意図なので、ブロックも分けて
         * ある。両方消したければ 2 つ並べる
         */
        clearHistory() {
            conversation.clearHistory();
        },

        /**
         * 返事を一文ずつ取り出す。ループブロックの中身になる。
         *
         *   for await (const sentence of api.replySentences(api.userText())) { ... }
         */
        async *replySentences(text) {
            for await (const sentence of conversation.replySentences(String(text))) {
                stopIfAborted();
                yield sentence;
            }
        },

        /**
         * 返事を考えて、吹き出しに出しながら話す。
         *
         * replySentences() を使った定型の流れをひとまとめにしたもの。
         * 細かく組み替えたいときは replySentences() を直接使う
         */
        async reply(text) {
            for await (const sentence of api.replySentences(text)) {
                api.showBubble(SPEAKER.character, sentence);
                await api.speakAndWait(sentence);
            }
        },

        //---------------------------------- 制御

        /** 指定した秒数だけ待つ。 */
        async wait(seconds) {
            stopIfAborted();
            await sleep(Math.max(0, Number(seconds) || 0) * 1000);
        },

        /**
         * ループ 1 周ごとに呼ぶ。中断を確かめ、画面が固まらないよう制御を返す。
         * ビジュアルプログラミングのループブロックが自動で挟む
         */
        async tick() {
            stopIfAborted();
            await sleep(0);
        },

        //---------------------------------- 値

        /** 直近のユーザの発話。 */
        userText() {
            return conversation.userText;
        },

        /** キャラクタの名前（設定ウインドウで決めたもの）。 */
        characterName() {
            return conversation.characterName;
        },

        /** from 以上 to 以下の整数の乱数。 */
        random(from, to) {
            const min = Math.min(Number(from), Number(to));
            const max = Math.max(Number(from), Number(to));
            return Math.floor(Math.random() * (max - min + 1)) + min;
        },

        /** text に word が含まれるか。 */
        includes(text, word) {
            return String(text).includes(String(word));
        },

        /** 2 つの文字列をつなぐ。 */
        join(a, b) {
            return String(a ?? "") + String(b ?? "");
        }
    };

    return api;
};

export default createAvatarApi;
