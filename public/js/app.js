
// 音声対話のコア
import ChatClient from "./chat-client.js";
import SpeechSynthesizer from "./speech-synthesizer.js";
import WebSpeechRecognizer from "./web-speech-recognizer.js";
import Conversation from "./app-conversation.js";

// 会話の節目でアバターが何をするか
import loadMotions from "./app-motions.js";
import createAvatarApi, {ActionStopped} from "./app-avatar-api.js";
import createActionRunner from "./app-action-runner.js";
import createActionProgram from "./app-action-program.js";
import createBlockEditor from "./app-block-editor.js";
import avatarActions from "./app-avatar-actions.js";

// 設定ウインドウ（話者・カメラの寄り・吹き出しの色・キャラクタ像）
import setupSettings from "./app-settings.js";

// 標準の alert / confirm / prompt の代わり。見た目を画面と揃える
import dialog from "./web-ui/dialog.js";

// 画面部品。読み込むだけでカスタム要素として登録される
import "./web-ui/chat-bubble-element.js";
import "./web-ui/chat-flow-element.js";
import "./web-ui/color-picker-element.js";
import "./web-ui/progress-bar-element.js";
import "./web-ui/settings-panel-element.js";
import "./web-ui/speech-recognition-element.js";

// 3D 表示
import "./three-ui/three-world-element.js";
import "./three-ui/vrm-avatar-element.js";
import "./three-ui/vrm-emote-element.js";

// モデルの読み込みと <three-world> への配置は <vrm-avatar> が行う（index.html を参照）
const avatar = document.querySelector("vrm-avatar");

// 頭の上に出す感情アイコン。<vrm-avatar> の子要素として置く。
// 要らなければ index.html から <vrm-emote> を消せばよく、そのときは
// エモートのブロックが何もしないだけで、ほかの機能はそのまま動く
const emote = document.querySelector("vrm-emote") ?? {
    ready: Promise.resolve(null),
    emoteNames: [],
    current: null,
    show: () => {},
    clear: () => {}
};

//----------------------------------
// モデルの読み込み状況を表示
//----------------------------------
let progressElement = undefined;

avatar.addEventListener("progress", (event) => {
    const progress = event.detail.value;
    if (! progressElement) {
        progressElement = document.createElement("progress-bar");
        document.body.appendChild(progressElement);
    }
    progressElement.value = progress;
    if (progress === 100) {
        setTimeout(() => {
            progressElement.remove();
        }, 1000);
    }
});

avatar.addEventListener("error", (event) => {
    dialog.alert(String(event.detail.error), {title: "モデルを読み込めませんでした"});
});


/** ビジュアルプログラミングで組んだアクション定義。 */
const ACTIONS_URL = "./actions.json";

/**
 * 試し実行のときだけ api にかぶせるもの。
 *
 * 「ユーザの発話」は、会話モードなら音声認識の結果が入っている。けれども
 * 編集中はマイクを止めているので空のままで、そのまま動かしても何も起きない
 * ように見えてしまう。試すときはその場で入力してもらう。
 *
 * 訊くのは 1 回だけ。同じ実行の中で「ユーザの発話」が何度出てきても、
 * 最初に入れた文字を使い回す（今の listenend は吹き出しと返事の 2 か所で
 * 使っているので、毎回訊くと煩わしい）。
 *
 * 取り消したらその実行ごと中断する。空のまま進めても結果が読めないため
 */
const createTrialApi = (api) => {
    let answer = null;

    const trialApi = Object.create(api);

    trialApi.userText = async () => {
        if (answer === null) {
            const input = await dialog.prompt(
                "ユーザが話しかけた言葉として使う文字を入れてください。", {
                    title: "ユーザの発話",
                    defaultValue: api.userText(),
                    placeholder: "こんにちは",
                    okText: "これで試す"
                });
            if (input === null) {
                throw new ActionStopped();
            }
            answer = input;
        }
        // 訊いている間に止められていないかを確かめる
        await api.tick();
        return answer;
    };

    return trialApi;
};

/**
 * アクションを登録する。
 *
 * イベント単位で JSON を優先し、JSON に無いイベントだけ手書きの関数を使う。
 * ブロックで直したものが必ず反映されるよう、この向きにしてある。
 * どちらを使ったかは起動時にコンソールへ出す
 *
 * @param {object} runner          app-action-runner
 * @param {object} handwritten     app-avatar-actions.js
 */
const registerActions = async (runner, handwritten, program = null) => {
    let fromJson = {};

    try {
        if (! program) {
            const response = await fetch(ACTIONS_URL);
            if (! response.ok) {
                throw new Error(`${response.status}`);
            }
            program = await response.json();
        }
        const compiled = createActionProgram(program);
        for (const warning of compiled.warnings) {
            console.warn(`アクション定義: ${warning}`);
        }
        fromJson = compiled.handlers;
    } catch (error) {
        console.warn(`アクション定義 (${ACTIONS_URL}) を読み込めませんでした。`
                     + `手書きのアクションだけを使います`, error);
    }

    const source = {};
    const types = new Set([...Object.keys(fromJson), ...Object.keys(handwritten)]);
    for (const type of types) {
        runner.on(type, fromJson[type] ?? handwritten[type]);
        source[type] = fromJson[type] ? ACTIONS_URL : "app-avatar-actions.js";
    }
    // 差し替えで消えたイベントの登録を残さない
    for (const type of runner.types) {
        if (! types.has(type)) {
            runner.off(type);
        }
    }
    console.info("アクションの取得元", source);
};


//--------------------------------------------------------
// DOMの操作や初期化処理をここに記述
//--------------------------------------------------------
document.addEventListener('DOMContentLoaded', function() {

    const speechSynthesizer = new SpeechSynthesizer();

    const chatClient = new ChatClient();
    const chatFlow = document.querySelector("chat-flow");
    const world = document.querySelector("three-world");

    //----------------------------------
    // 設定ウインドウ
    //
    // 設定の中身は app-settings.js が持つ。ここで渡すのは設定が書き換える
    // 対象で、アプリの主要オブジェクトがそのまま並ぶ
    //----------------------------------
    const creditElement = document.querySelector("#credit");

    setupSettings({
        avatar, world, chatFlow, chatClient, speechSynthesizer,
        // VOICEVOX の利用規約により、実際に使用したキャラクターのクレジット表記が必要。
        // 設定ウインドウではなく常時表示なので、ここで面倒を見る
        onSpeakerChange: (speaker) => {
            creditElement.textContent = `VOICEVOX: ${speaker.character}`;
        }
    });

    //----------------------------------
    // 会話履歴
    //----------------------------------
    document.querySelector("#clear-history").addEventListener("click", () => {
        chatClient.clearHistory();
        chatFlow.clearMessages();
    });

    //----------------------------------
    // 会話の進行と、それに対するアクション
    //
    // 会話の節目は conversation がイベントとして出す。
    // 何をするかは app-avatar-actions.js に書く（このファイルには書かない）
    //----------------------------------
    const conversation = new Conversation({chatClient});

    const runner = createActionRunner({
        conversation,
        createApi: (signal) => createAvatarApi({
            avatar, emote, chatFlow, speechSynthesizer, conversation, signal
        }),
        // 応答のアクションが終わったら入力待ちへ戻す
        onSettled: (type) => {
            if (type === "listenend") {
                conversation.enterIdle();
            }
        }
    });

    const actionsRegistered = registerActions(runner, avatarActions);

    //----------------------------------
    // ブロック編集画面
    //
    // 開くのは設定ウインドウから、閉じるのは編集画面から。編集のたびに
    // 設定を開き直さずに済む。#edit を付けた URL でも開いた状態で始められる
    //----------------------------------
    const blockEditor = createBlockEditor({
        actionsUrl: ACTIONS_URL,
        getNames: () => ({
            motionNames: avatar.motionNames,
            emoteNames: emote.emoteNames
        }),
        // 保存できたら、リロードせずに新しい動作へ差し替える
        onSave: async (program) => {
            runner.abortAll();
            await registerActions(runner, avatarActions, program);
        },

        //----------------------------------
        // ブロックを試しに動かすための手立て
        //
        // 編集画面は「何をどう実行するか」を知らない。アクションを走らせる
        // 仕組みはここにあるので、必要な操作だけを渡す
        //----------------------------------
        trial: {
            run: (key, action) => runner.runOnce(key, (api) => action(createTrialApi(api))),
            isRunning: (key) => runner.isRunning(key),
            stop: (key) => {
                runner.abort(key);
                // 発話を訊くダイアログが開いたままなら閉じる。
                // 中断したのに問いだけ残ると、何も起きていないように見える
                dialog.dismiss();
            },

            /**
             * 編集モードに入る／出る。
             *
             * 編集中はイベント実行を止める。止めないと、試している最中に
             * 会話のアクションが割り込んで声が重なる。
             * マイクも止める。認識結果だけ出てアバターが無反応になると、
             * 壊れたように見えるため
             */
            setEditing: (editing) => {
                // これから起きるイベントを無視する。abortAll だけでは
                // 「編集中に発生したイベント」を止められない
                runner.setPaused(editing);
                runner.abortAll();
                speechRecognitionElement.disabled = editing;
                if (editing) {
                    avatar.stopSpeaking();
                } else {
                    // 本番へ戻すときに入力待ちへ入れ直す。編集中に中断した
                    // ぶん、会話の状態が宙に浮いたままになっている
                    conversation.enterIdle();
                }
            }
        }
    });

    document.querySelector("#open-editor").addEventListener("click", () => {
        document.querySelector("settings-panel").removeAttribute("open");
        blockEditor.open();
    });

    // 編集できないサーバでは項目ごと隠す（外部公開時の運用）
    fetch("/api/status")
        .then((response) => response.json())
        .then((status) => {
            if (status.actions_editable !== false) {
                document.querySelector("#editor-section").hidden = false;
            }
            if (status.actions_editable !== false && location.hash === "#edit") {
                blockEditor.open();
            }
        })
        .catch((error) => console.warn("状態を取得できませんでした", error));

    // 待機中のアクションは、会話が始まったら止める。
    // 止めないと「ずっと」で書いた待機の仕草が会話中も回り続ける
    runner.cancelOn("idle", "listenstart");

    //----------------------------------
    // 認識した文字の表示
    //
    // 吹き出しは確定した瞬間に追加する。返事の吹き出しは必ず LLM の await を
    // 挟むので、この同期的な追加が先に届き、順序は自然に守られる。
    // 画面下の文字はそのまま少し残してから溶かす（情報が移ったことを見せる）
    //----------------------------------
    const resultElement = document.querySelector("#speech-recognition-result");

    // 認識結果を画面下部に出しておく時間（ミリ秒）
    const RESULT_HOLD_MS = 1500;

    // フェードの時間は CSS の transition を唯一の定義とし、ここでは読み取るだけにする。
    // transitionDuration の計算値は秒に正規化されるため、CSS 側が ms 表記でも正しく読める
    const RESULT_FADE_MS =
          parseFloat(getComputedStyle(resultElement).transitionDuration) * 1000;

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // 表示中に次の認識が始まったとき、古い処理が新しい表示を消さないようにする
    let recognizedGeneration = 0;

    /** 認識中の文字を画面下部に出す。確定していないので吹き出しにはしない。 */
    const showInterimText = (text) => {
        ++recognizedGeneration;
        resultElement.classList.remove("fade-out");
        resultElement.textContent = text;
    };

    /** 確定した文字を画面下部に残しつつ、徐々に消す。 */
    const fadeOutRecognizedText = async () => {
        const generation = ++recognizedGeneration;
        const isCurrent = () => generation === recognizedGeneration;

        await delay(RESULT_HOLD_MS);
        if (isCurrent()) {
            resultElement.classList.add("fade-out");
            await delay(RESULT_FADE_MS);
        }
        if (isCurrent()) {
            resultElement.textContent = "";
            resultElement.classList.remove("fade-out");
        }
    };

    conversation.addEventListener("listenend", (event) => {
        //chatFlow.appendMessage(event.detail.text, "right");
        fadeOutRecognizedText();
    });

    //----------------------------------
    // 音声認識
    //----------------------------------
    const speechRecognitionElement = document.querySelector("speech-recognition");

    // 使用する音声認識の実装を選ぶ。別の認識方式に変えるときは、
    // SpeechRecognizer を継承した実装を作ってここを差し替える
    // （js/speech-recognizer.js 参照）
    if (WebSpeechRecognizer.isSupported()) {
        const recognizer = new WebSpeechRecognizer();

        // 認識中の文字を画面下部に流す。会話の節目ではないので
        // conversation のイベントにはせず、ここで表示だけを受け持つ
        recognizer.oninterimresult = (event) => {
            showInterimText(event.detail.text);
        };

        // 会話の進行は conversation が受け持つ（イベントへ変換する）
        conversation.recognizer = recognizer;

        // 配線し終えてから要素へ渡す。渡すまでマイクボタンは押せない
        speechRecognitionElement.recognizer = recognizer;

    } else {
        console.warn("このブラウザは Web Speech API に対応していないため、"
                     + "音声入力を使えません。");
    }

    speechRecognitionElement.setInputLevel(0);

    // モデルとモーションが揃ったら会話を始められる。ready → idle の順でイベントが出る。
    // モーションとエモートの読み込みを先に済ませるのは、ready のアクションから
    // すぐ playMotion() や showEmote() を呼べるようにするため。
    // エモートは失敗しても続ける（アイコンが無くても会話はできる）
    avatar.ready
        .then(() => Promise.all([
            loadMotions(avatar),
            emote.ready.catch(() => {})
        ]))
        // アクションの登録を待ってから ready を出す。
        // そうしないと最初のイベントを取りこぼす
        .then(() => actionsRegistered)
        .then(() => conversation.markReady())
        .catch((error) => console.warn(error));
});


