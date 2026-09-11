
// 音声対話のコア
import ChatClient from "./chat-client.js";
import SpeechSynthesizer from "./speech-synthesizer.js";
import WebSpeechRecognizer from "./web-speech-recognizer.js";

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

    /**
     * 認識中の文字を画面下部に出す。確定していないので吹き出しにはしない。
     *
     * 前の認識結果を消している途中なら、世代を進めてその処理を打ち切る
     * （消去が走って、表示し始めた今回の文字を消してしまわないように）
     */
    const showInterimText = (text) => {
        ++recognizedGeneration;
        resultElement.classList.remove("fade-out");
        resultElement.textContent = text;
    };

    /**
     * 認識結果を画面下部にしばらく表示し、徐々に消してから吹き出しへ移す。
     * @returns {Promise<void>} 吹き出しを出し終えた時点で解決する
     */
    const showRecognizedText = async (text) => {
        const generation = ++recognizedGeneration;
        const isCurrent = () => generation === recognizedGeneration;

        resultElement.classList.remove("fade-out");
        resultElement.textContent = text;

        await delay(RESULT_HOLD_MS);
        if (isCurrent()) {
            resultElement.classList.add("fade-out");
            await delay(RESULT_FADE_MS);
        }
        if (isCurrent()) {
            resultElement.textContent = "";
            resultElement.classList.remove("fade-out");
        }

        // 追い越された場合でも、発話内容は吹き出しとして残す
        chatFlow.appendMessage(text, "right");
    };

    const speechRecognitionElement = document.querySelector("speech-recognition");

    // 音声認識に成功した時
    const onRecognized = async (event) => {
        const text = event.detail.text;

        // 発話と並行してモーションと表情を動かす。完了を待ちたい場合は await を付ける
        avatar.playMotion("Hand Raising").catch((error) => console.warn(error));
        avatar.tweenExpression("happy", 1.0, 0.3);

        // 認識結果の表示 → フェードアウト → 右側の吹き出し。
        // ここで待たずに進めて、表示している間に応答の生成を走らせる
        const userMessage = showRecognizedText(text);

        try {
            // 応答は文が完成した順に届く。生成の完了を待たずに発話を始められる。
            // 吹き出しも文ごとに出すので、喋っている内容と表示が一致する
            for await (const sentence of chatClient.stream(text)) {
                // ユーザーの吹き出しより先に応答を出さない（実質的に待つのは初回だけ）
                await userMessage;
                chatFlow.appendMessage(sentence, "left");

                const arrayBuffer = await speechSynthesizer.createSound(sentence);
                await avatar.speak(arrayBuffer);
            }

        } catch (error) {
            console.error(error);
            await userMessage;
            chatFlow.appendMessage(error.message, "left");
            // TODO: エラー時の動作と音声を設定すること
            // 例えば、「聞こえませんでした」と発話している音声ファイルのパスを設定する
            await avatar.speak("./mp3/konnichiwa.mp3");
        }

        // 発話が終わったら表情を戻す
        await avatar.tweenExpression("happy", 0, 0.5);
    };

    // 使用する音声認識の実装を選ぶ。別の認識方式に変えるときは、
    // SpeechRecognizer を継承した実装を作ってここを差し替える
    // （js/speech-recognizer.js 参照）
    if (WebSpeechRecognizer.isSupported()) {
        const recognizer = new WebSpeechRecognizer();

        // 認識中の文字を画面下部に流す
        recognizer.oninterimresult = (event) => {
            showInterimText(event.detail.text);
         };
        // 認識結果が確定した
        recognizer.onresult = onRecognized;
        // 認識に失敗した
        recognizer.onerror = (event) => {

        };
        // 認識の信頼度が閾値以下だった（基本的には発生しない）
        recognizer.onnomatch = (event) => {

        };

        // 配線し終えてから要素へ渡す。渡すまでマイクボタンは押せない
        speechRecognitionElement.recognizer = recognizer;

    } else {
        console.warn("このブラウザは Web Speech API に対応していないため、"
                     + "音声入力を使えません。");
    }

    speechRecognitionElement.setInputLevel(0);
});


