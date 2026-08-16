
// 音声対話のコア
import ChatClient from "./chat-client.js";
import SpeechSynthesizer from "./speech-synthesizer.js";
import WebSpeechRecognizer from "./web-speech-recognizer.js";

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

    //----------------------------------
    // 設定の保存（この端末のみ）
    //
    // localStorage は容量超過やプライベートモードで例外を投げるため、
    // 読み書きは必ず包む。保存できなくてもアプリは動き続ける
    //----------------------------------
    const SETTINGS_KEY = "vrmtalker.settings";

    const readStoredSettings = () => {
        try {
            return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || null;
        } catch (error) {
            console.warn("保存された設定を読み込めませんでした", error);
            return null;
        }
    };
    const storedSettings = readStoredSettings();

    // 既定の話者。破棄したときに戻す先として、書き換わる前に控えておく
    const DEFAULT_STYLE_ID = speechSynthesizer.styleId;

    const creditElement = document.querySelector("#credit");
    const speakerSelect = document.querySelector("#speaker-select");

    // VOICEVOX の利用規約により、実際に使用したキャラクターのクレジット表記が必要
    const updateCredit = (speakers) => {
        const speaker = speakers.find((s) => s.style_id === speechSynthesizer.styleId);
        if (speaker) {
            creditElement.textContent = `VOICEVOX: ${speaker.character}`;
        }
    };

    // 話者を切り替える。話者一覧が届く前に呼ばれても良いよう関数にしておく
    let applyStyleId = (styleId) => {
        speechSynthesizer.styleId = styleId;
    };

    speechSynthesizer.getSpeakers()
        .then((speakers) => {
            // 設定ウインドウの話者選択を組み立てる
            for (const speaker of speakers) {
                const option = document.createElement("option");
                option.value = speaker.style_id;
                option.textContent = `${speaker.character}（${speaker.style}）`;
                speakerSelect.appendChild(option);
            }

            applyStyleId = (styleId) => {
                const exists = [...speakerSelect.options]
                      .some((option) => Number(option.value) === styleId);
                const applied = exists ? styleId : DEFAULT_STYLE_ID;
                speechSynthesizer.styleId = applied;
                speakerSelect.value = String(applied);
                updateCredit(speakers);
            };

            speakerSelect.addEventListener("change", () => {
                applyStyleId(Number(speakerSelect.value));
            });

            // 保存された話者があれば復元する
            applyStyleId(storedSettings?.styleId ?? DEFAULT_STYLE_ID);
        })
        .catch((error) => {
            console.warn(error);
        });

    const chatClient = new ChatClient();

    const chatFlow = document.querySelector("chat-flow");

    document.querySelector("#clear-history").addEventListener("click", () => {
        chatClient.clearHistory();
        chatFlow.clearMessages();
    });

    //----------------------------------
    // キャラクタの大きさ（カメラの寄り具合）
    //
    // <chat-flow> が画面を覆っていてホイール操作が届かないため、
    // スライダーでカメラと注視点の距離を変える
    //----------------------------------
    const ZOOM_NEAREST = 0.6;   // スライダー最大のときの距離（大きく見える）
    const ZOOM_FARTHEST = 6.0;  // スライダー最小のときの距離（小さく見える）

    const zoomSlider = document.querySelector("#zoom-slider");
    const world = document.querySelector("three-world");

    const applyZoom = () => {
        const ratio = Number(zoomSlider.value) / Number(zoomSlider.max);
        const distance = ZOOM_FARTHEST + (ZOOM_NEAREST - ZOOM_FARTHEST) * ratio;
        // 注視点（頭部）はそのままに、距離だけを変える
        world.setFocus(world.controls.target.clone(), {distance});
    };

    zoomSlider.addEventListener("input", applyZoom);

    // モデルの体格から決まる既定値。破棄したときに戻す先になる
    let defaultZoomValue = Number(zoomSlider.value);

    avatar.ready.then(() => {
        // 注視点が決まった後の実距離をスライダーの目盛りに換算する
        const distance = world.camera.position.distanceTo(world.controls.target);
        const ratio = (ZOOM_FARTHEST - distance) / (ZOOM_FARTHEST - ZOOM_NEAREST);
        defaultZoomValue =
            Math.round(Math.min(Math.max(ratio, 0), 1) * Number(zoomSlider.max));

        zoomSlider.value = storedSettings?.zoom ?? defaultZoomValue;
        if (storedSettings?.zoom !== undefined) {
            applyZoom();
        }
    }).catch(() => {});

    //----------------------------------
    // 吹き出しの色
    //
    // <chat-bubble> は fill / color を CSS 変数で参照しているため、
    // <chat-flow> の変数を書き換えるだけで表示中の吹き出しも追従する
    //----------------------------------

    // カスタムプロパティの計算値は var(...) のまま返るので、
    // 実際の色は color に適用した測定用の要素から読む
    const colorProbe = document.createElement("span");
    colorProbe.setAttribute("aria-hidden", "true");
    colorProbe.style.display = "none";
    document.body.appendChild(colorProbe);

    const resolveColor = (expression) => {
        colorProbe.style.color = "";
        colorProbe.style.color = expression;
        return getComputedStyle(colorProbe).color;   // "rgb(r, g, b)"
    };
    const withAlpha = (rgb, alpha) =>
          rgb.replace(/^rgba?\(([^)]+)\)$/, (_, values) =>
              `rgba(${values.split(",").slice(0, 3).map((v) => v.trim()).join(", ")}, ${alpha})`);

    const BUBBLE_FILL_ALPHA = 0.92;

    // 吹き出しの色と、<chat-flow> のどの変数に書き込むか
    const bubbleColorSettings = [
        {
            id: "left-fill",
            initial: withAlpha(resolveColor("var(--pop-pink)"), BUBBLE_FILL_ALPHA),
            apply: (picker) => {
                chatFlow.style.setProperty("--left-bubble-fill", picker.rgb);
                chatFlow.style.setProperty("--left-bubble-fill-opacity", picker.alpha);
            }
        },
        {
            id: "left-text",
            initial: resolveColor("#ffffff"),
            apply: (picker) => {
                chatFlow.style.setProperty("--left-bubble-font-color", picker.value);
            }
        },
        {
            id: "right-fill",
            initial: withAlpha(resolveColor("var(--pop-blue)"), BUBBLE_FILL_ALPHA),
            apply: (picker) => {
                chatFlow.style.setProperty("--right-bubble-fill", picker.rgb);
                chatFlow.style.setProperty("--right-bubble-fill-opacity", picker.alpha);
            }
        },
        {
            id: "right-text",
            initial: resolveColor("#ffffff"),
            apply: (picker) => {
                chatFlow.style.setProperty("--right-bubble-font-color", picker.value);
            }
        }
    ];

    // 保存された色があれば復元する。無ければ既定値
    const applyBubbleColor = (setting, color) => {
        const picker = document.querySelector(`#${setting.id}`);
        picker.value = color;
        setting.apply(picker);
    };

    for (const setting of bubbleColorSettings) {
        const picker = document.querySelector(`#${setting.id}`);
        applyBubbleColor(setting, storedSettings?.colors?.[setting.id] ?? setting.initial);
        picker.addEventListener("input", () => setting.apply(picker));
    }

    //----------------------------------
    // 設定の保存 / 破棄
    //----------------------------------
    const saveButton = document.querySelector("#save-settings");
    const resetButton = document.querySelector("#reset-settings");

    /** 押したことが分かるよう、一時的にチェックアイコンへ差し替える */
    const flashDone = (button) => {
        button.dataset.done = "";
        clearTimeout(button._doneTimer);
        button._doneTimer = setTimeout(() => {
            delete button.dataset.done;
        }, 1200);
    };

    saveButton.addEventListener("click", () => {
        const settings = {
            zoom: Number(zoomSlider.value),
            styleId: speechSynthesizer.styleId,
            colors: Object.fromEntries(bubbleColorSettings.map((setting) =>
                [setting.id, document.querySelector(`#${setting.id}`).value]))
        };
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
            flashDone(saveButton);
        } catch (error) {
            // 容量超過やプライベートモードなど。保存できなくても動作は続ける
            console.warn("設定を保存できませんでした", error);
            window.alert("設定を保存できませんでした。");
        }
    });

    resetButton.addEventListener("click", () => {
        try {
            localStorage.removeItem(SETTINGS_KEY);
        } catch (error) {
            console.warn("保存された設定を消せませんでした", error);
        }

        // 保存を消すだけでは画面が変わらないので、初期値へ戻して結果が見えるようにする
        for (const setting of bubbleColorSettings) {
            applyBubbleColor(setting, setting.initial);
        }
        applyStyleId(DEFAULT_STYLE_ID);
        zoomSlider.value = defaultZoomValue;
        applyZoom();

        flashDone(resetButton);
    });

    //----------------------------------
    // アバターのモデル名（VRM の meta より）
    //----------------------------------
    const modelNameElement = document.querySelector("#model-name");

    avatar.ready
        .then(() => {
            const meta = avatar.humanoid.getMeta();
            // VRM 1.0 は name、VRM 0.x は title
            modelNameElement.textContent = meta?.name || meta?.title || "（名称なし）";
        })
        .catch(() => {
            modelNameElement.textContent = "読み込めませんでした";
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

//--------------------------------------------------------
// ページ全体の読み込み完了後の処理をここに記述
//--------------------------------------------------------
window.addEventListener('load', function() {

    //----------------------------------
    // 画面サイズへの追従
    //
    // 位置と大きさは index.html の CSS（clamp / env）が決める。
    // ここで補うのは「<chat-flow> の下端を、実際に描画されたボタンの位置から
    // 空ける」ことだけ。CSS だけでは他要素の実寸を参照できないため
    //----------------------------------
    const recognitionElement = document.querySelector("speech-recognition");

    const layout = () => {
        const bounding = recognitionElement.getBoundingClientRect();
        // ボタンの下側の余白と同じだけ、上側にも空ける
        const inset = parseFloat(getComputedStyle(recognitionElement).bottom) || 0;
        const reserved = (window.innerHeight - bounding.top) + inset;
        document.documentElement.style.setProperty(
            "--chat-flow-bottom", `${Math.round(reserved)}px`);
    };

    window.addEventListener("resize", layout);
    layout();
});

