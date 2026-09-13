
// 音声対話のコア
import ChatClient from "./chat-client.js";
import SpeechSynthesizer from "./speech-synthesizer.js";
import WebSpeechRecognizer from "./web-speech-recognizer.js";
import Conversation from "./app-conversation.js";

// 会話の節目でアバターが何をするか
import loadMotions from "./app-motions.js";
import createAvatarApi from "./app-avatar-api.js";
import createActionRunner from "./app-action-runner.js";
import avatarActions from "./app-avatar-actions.js";

// 設定ウインドウ（話者・カメラの寄り・吹き出しの色・キャラクタ像）
import setupSettings from "./app-settings.js";

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

// モデルの読み込みと <three-world> への配置は <vrm-avatar> が行う（index.html を参照）
const avatar = document.querySelector("vrm-avatar");

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
    window.alert(event.detail.error);
});


/*
//--------------------------------------------------------
// モデルの読み込み完了後に行う処理はここに記述
//--------------------------------------------------------
avatar.ready.then(() => {
    // print meta fields
    const meta = avatar.humanoid.getMeta();
    Object.keys(meta).forEach((key) => {
        document.getElementById("meta").innerText += key + ' : ' + meta[key] + '\n';
        document.getElementById("thumbnail").src = meta.thumbnailImage.src;
    });
});
*/

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
            avatar, chatFlow, speechSynthesizer, conversation, signal
        }),
        // 応答のアクションが終わったら入力待ちへ戻す
        onSettled: (type) => {
            if (type === "listenend") {
                conversation.enterIdle();
            }
        }
    });

    for (const [type, handler] of Object.entries(avatarActions)) {
        runner.on(type, handler);
    }

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
        chatFlow.appendMessage(event.detail.text, "right");
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
    // モーションの読み込みを先に済ませるのは、ready のアクションから
    // すぐ playMotion() を呼べるようにするため
    avatar.ready
        .then(() => loadMotions(avatar))
        .then(() => conversation.markReady())
        .catch((error) => console.warn(error));
});


