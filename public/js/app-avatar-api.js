/**
 * アクションから呼べる関数。
 *
 * ここにある関数が、そのままビジュアルプログラミングのブロック 1 個になる。
 * そのため次の制約を守ること。
 *
 *   - 引数はプリミティブだけ（文字列・数値・真偽）。オブジェクトを受け取らない
 *   - モーション・ポーズ・ジェスチャー・エモート・効果音・背景・ボイスデータは、定義ファイルの id で
 *     受け取る（画面に出す名前は後から変わりうるため）
 *   - 1 関数 = 1 ブロック。オプションの入れ物（{a, b}）を使わない
 *   - 例外を投げない。失敗は警告を出して続ける（利用者の画面を壊さない）
 *   - 「終わるまで待つ」版は関数名を分ける（…AndWait）
 *
 * 中断だけは例外で伝える。アクションの実行を途中で止める唯一の手段であり、
 * 呼び出し側（app-action-runner.js）が握りつぶすため、利用者には見えない。
 */

import {stripEmoji} from "./emotion.js";

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
 * @param {object}      deps.voices            VoiceLibrary
 * @param {object}      deps.poses             PoseLibrary（ポーズ）
 * @param {object}      deps.gestures          PoseLibrary（ジェスチャー）
 * @param {object}      deps.background        Background
 * @param {object}      deps.toast             画面に短い知らせを出すもの
 * @param {object}      deps.stopwatch         Stopwatch（アプリ全体で 1 つ）
 * @param {object}      deps.conversation      Conversation
 * @param {AbortSignal} deps.signal            中断の合図
 */
const createAvatarApi = ({avatar, emote, chatFlow, speechSynthesizer, sounds, voices,
                          poses, gestures, background, toast, stopwatch, conversation,
                          signal}) => {

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
        // 絵文字は読み上げない（返事の頭の感情の絵文字や、ブロックに書いた絵文字）。
        // 絵文字だけなら、話すことが無い
        const spoken = stripEmoji(text);
        if (! spoken) {
            return;
        }
        const arrayBuffer = await speechSynthesizer.createSound(spoken);
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

        /**
         * ボイスデータを再生する。終わるのを待たない。
         *
         * アバターの発話として鳴らすので口が動く（効果音との違い）。
         * 受け取るのは voices/voices.json の id
         */
        playVoice(id) {
            const file = voices.fileOf(id);
            if (! file) {
                console.warn(`ボイスデータ "${id}" がありません`);
                return;
            }
            guard(() => avatar.speak(file), "ボイスデータの再生").catch(() => {});
        },

        /** ボイスデータを再生して、終わるまで待つ。 */
        async playVoiceAndWait(id) {
            stopIfAborted();
            const file = voices.fileOf(id);
            if (! file) {
                console.warn(`ボイスデータ "${id}" がありません`);
                return;
            }
            await guard(() => avatar.speak(file), "ボイスデータの再生");
        },

        /** 話している音声を止める。 */
        stopSpeaking() {
            avatar.stopSpeaking();
        },

        /** モーションを再生する。終わるのを待たない。渡すのは定義の id。 */
        playMotion(id) {
            guard(() => avatar.playMotion(String(id)), "モーションの再生").catch(() => {});
        },

        /** モーションを再生して、終わるまで待つ。 */
        async playMotionAndWait(id) {
            stopIfAborted();
            await guard(() => avatar.playMotion(String(id)), "モーションの再生");
        },

        /**
         * ポーズをとる。別のポーズをとるか、stopPose() するまで保つ。
         *
         * ポーズは待機モーションの代わりになる。ポーズの間に再生したモーションは、
         * 終わるとポーズへ戻る。受け取るのは animations/poses.json の id
         */
        takePose(id) {
            const template = poses.templateOf(id);
            if (! template) {
                console.warn(`ポーズ "${id}" がありません`);
                return;
            }
            guard(() => avatar.takePose(template), "ポーズ").catch(() => {});
        },

        /** ポーズを決めた秒数だけとって、待機モーションへ戻る。戻るのを待たない。 */
        takePoseFor(id, seconds) {
            const template = poses.templateOf(id);
            if (! template) {
                console.warn(`ポーズ "${id}" がありません`);
                return;
            }
            guard(() => avatar.takePose(template, Math.max(0, Number(seconds) || 0)), "ポーズ")
                .catch(() => {});
        },

        /** ポーズを決めた秒数だけとって、戻り始めるまで待つ。 */
        async takePoseForAndWait(id, seconds) {
            stopIfAborted();
            const template = poses.templateOf(id);
            if (! template) {
                console.warn(`ポーズ "${id}" がありません`);
                return;
            }
            await guard(() => avatar.takePose(template, Math.max(0, Number(seconds) || 0)),
                        "ポーズ");
        },

        /** ポーズをやめて、待機モーションへ戻る。 */
        stopPose() {
            guard(() => avatar.takePose(null), "ポーズ").catch(() => {});
        },

        /**
         * ジェスチャー（腕と手の身ぶり）をする。戻るのを待たない。
         *
         * モーションやポーズの上から重ねる。1 秒かけて寄せ、始めてから seconds 秒
         * たったら 1 秒かけて戻す。受け取るのは animations/gestures.json の id
         *
         * @param {string} hand "right" | "left"。アバター自身から見た手
         */
        playGesture(hand, id, seconds) {
            const template = gestures.templateOf(id);
            if (! template) {
                console.warn(`ジェスチャー "${id}" がありません`);
                return;
            }
            guard(() => avatar.playGesture(template, {
                hand: String(hand), seconds: Math.max(0, Number(seconds) || 0)
            }), "ジェスチャー").catch(() => {});
        },

        /** ジェスチャーをして、戻し終えるまで待つ。 */
        async playGestureAndWait(hand, id, seconds) {
            stopIfAborted();
            const template = gestures.templateOf(id);
            if (! template) {
                console.warn(`ジェスチャー "${id}" がありません`);
                return;
            }
            await guard(() => avatar.playGesture(template, {
                hand: String(hand), seconds: Math.max(0, Number(seconds) || 0)
            }), "ジェスチャー");
        },

        /** ジェスチャーをやめる（1 秒かけて戻す）。 */
        stopGesture() {
            avatar.stopGesture();
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

        /**
         * 表情を全部、徐々に消す。消え切るのを待たない。
         *
         * 会話の途中で「今の表情が何であれ、ふつうの顔に戻す」ときに使う。
         * clearExpression() は一気に戻るので、途中だと不自然に見える。
         * まばたきと口の形は消えない
         */
        clearExpressionIn(seconds) {
            guard(() => avatar.fadeOutExpressions(Number(seconds)), "表情の変更")
                .catch(() => {});
        },

        /** 表情を全部、徐々に消して、消え切るまで待つ。 */
        async clearExpressionInAndWait(seconds) {
            stopIfAborted();
            await guard(() => avatar.fadeOutExpressions(Number(seconds)), "表情の変更");
        },

        /** カメラの注視点をボーンに合わせる。視線（gaze…）とは別の話。 */
        lookAt(boneName) {
            avatar.focusCamera(String(boneName));
        },

        /**
         * 視線をカメラへ向けて、そこで止める。
         *
         * 動くのは目だけで、頭は回らない（VRM の視線はそう決まっている）
         */
        gazeAtCamera() {
            avatar.gazeAtCamera();
        },

        /** 視線でカメラを追いかける。読み込んだ直後の状態へ戻す。 */
        gazeFollowCamera() {
            avatar.gazeFollowCamera();
        },

        /**
         * 視線を向ける。向きは画面から見たほう。
         *
         * @param {string} direction "right" | "left" | "up" | "down" | "front"
         * @param {number} degrees   見込みの角度
         */
        gazeTo(direction, degrees) {
            avatar.gazeTo(String(direction), Number(degrees));
        },

        /**
         * 頭の上に感情アイコンを出す。消えるのを待たない。
         *
         * 話しながらアイコンを出す使い方が主なので、こちらが既定。
         * seconds が 0 以下なら clearEmote() を呼ぶまで出したままにする
         */
        showEmote(id, seconds) {
            guard(() => emote.show(String(id), Number(seconds)), "エモートの表示")
                .catch(() => {});
        },

        /** 感情アイコンを出して、消えるまで待つ。 */
        async showEmoteAndWait(id, seconds) {
            stopIfAborted();
            await guard(() => emote.show(String(id), Number(seconds)), "エモートの表示");
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
        playSoundEffect(id) {
            sounds.play(String(id));
        },

        /** 効果音を鳴らして、鳴り終わるまで待つ。 */
        async playSoundEffectAndWait(id) {
            stopIfAborted();
            await guard(() => sounds.playAndWait(String(id)), "効果音の再生");
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
        setBackground(id) {
            guard(() => background.set(String(id)), "背景の変更").catch(() => {});
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
         * ストップウォッチを操作する（stopwatch.js を参照）。
         * @param {string} action "start"（開始）| "stop"（停止）| "reset"（リセット）
         */
        controlStopwatch(action) {
            switch (String(action)) {
            case "start": stopwatch.start(); break;
            case "stop":  stopwatch.stop();  break;
            case "reset": stopwatch.reset(); break;
            default:
                console.warn(`ストップウォッチの操作 "${action}" はありません`);
            }
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

        /**
         * 直近の返事の感情が emotion か。
         *
         * 感情は、LLM が返事の最初に付ける絵文字から読み取る（js/emotion.js）。
         * 最初の一文が届いた時点で分かるので、返事を一文ずつ受け取るループの
         * 中でも、言い終えた後でも使える。感情が読み取れなかった返事では、
         * どの感情でも false
         *
         * @param {string} emotion js/emotion.js の EMOTIONS の id（"happy" など）
         */
        replyHasEmotion(emotion) {
            return conversation.replyEmotion === String(emotion);
        },

        /** ストップウォッチの値（秒。0.1 秒単位）。 */
        stopwatch() {
            return stopwatch.seconds;
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
        },

        /**
         * 今の日時の一部。パソコン（ブラウザ）の時計の値。
         *
         * 曜日だけは「月」〜「日」の文字、ほかは数を返す
         * （Scratch の「現在の〇〇」と同じ。ただし Scratch の曜日は 1＝日曜の数）。
         *
         * @param {string} unit "year" | "month" | "date" | "day-of-week" |
         *                      "hour" | "minute" | "second"
         */
        currentTime(unit) {
            const now = new Date();
            switch (String(unit)) {
            case "year":        return now.getFullYear();
            case "month":       return now.getMonth() + 1;
            case "date":        return now.getDate();
            case "day-of-week": return "日月火水木金土"[now.getDay()];
            case "hour":        return now.getHours();
            case "minute":      return now.getMinutes();
            case "second":      return now.getSeconds();
            default:
                console.warn(`現在の日時の項目 "${unit}" はありません`);
                return "";
            }
        }
    };

    return api;
};

export default createAvatarApi;
