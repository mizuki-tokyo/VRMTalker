
// 音声対話のコア
import ChatClient from "./chat-client.js";
import SpeechSynthesizer from "./speech-synthesizer.js";
import SoundPlayer from "./sound-player.js";
import VoiceLibrary from "./voices.js";
import Background from "./background.js";
import Toast from "./web-ui/toast.js";
import WebSpeechRecognizer from "./web-speech-recognizer.js";
import Conversation from "./app-conversation.js";

// 会話の節目でアバターが何をするか
import {readMotions, registerMotions} from "./app-motions.js";
import createAvatarApi, {ActionStopped} from "./app-avatar-api.js";
import createActionRunner from "./app-action-runner.js";
import createActionProgram from "./app-action-program.js";
import createBlockEditor from "./app-block-editor.js";
import avatarActions from "./app-avatar-actions.js";

// 設定ウインドウ（話者・カメラの寄り・吹き出しの色・キャラクタ像）
import setupSettings from "./app-settings.js";

// 謝辞（素材の出典と、3D モデルに埋め込まれた情報）
import {showAcknowledgment, showModelInfo} from "./app-credits.js";

// 標準の alert / confirm / prompt の代わり。見た目を画面と揃える
import dialog, {ICONS} from "./web-ui/dialog.js";

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
    iconsReady: Promise.resolve(),
    emoteChoices: [],
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

    // 効果音。定義（sounds/sounds.json）はここですぐ読み始める。
    // ブロックのドロップダウンの選択肢になるので、編集画面が開くより先に
    // 揃えておきたい。モデルの読み込みを待つ理由は無い
    const sounds = new SoundPlayer();
    const soundsLoaded = sounds.load();

    // ボイスデータ（録っておいた声）。効果音と同じく、一覧は先に読んでおく
    const voices = new VoiceLibrary();
    const voicesLoaded = voices.load();

    /**
     * モーションの選択肢（{id, name} の並び）。
     *
     * 定義を読んだ時点で入る。実体（クリップ）はモデルが要るので後から作るが、
     * 「何が選べるか」はそれを待たずに分かる
     */
    let motionChoices = [];
    const motionsRead = readMotions().then((motions) => {
        motionChoices = motions.map(({id, name}) => ({id, name}));
        return motions;
    });

    const screenElement = document.querySelector("#screen");

    // 背景。最初に出す絵は index.html が決める（#screen の style）。
    // ここで読むのは、あとから切り替えられる絵の一覧
    const background = new Background(screenElement);
    const backgroundsLoaded = background.load();

    /**
     * 画面に出す短い知らせ。
     *
     * 出す先を #screen にするのは、編集画面を開いて左右に分かれたときに、
     * 隠れず、残った側の真ん中に出るようにするため（#screen には transform が
     * 掛かっているので、中の position:fixed はこの要素を基準に決まる）。
     *
     * 場所を真ん中にしているのは、エラーのように必ず気づいてほしい知らせに
     * 使うため。下は操作列（マイクと認識結果）と重なる
     */
    const toast = {
        show: (text, seconds) => Toast.show(
            text, Math.max(0, seconds) * 1000, Toast.POSITION.CENTER, screenElement)
    };

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
    // メニューの操作
    //
    // どちらも押したらメニューを閉じる。結果はアバターの側に出るので、
    // 開いたままだと見えない
    //----------------------------------
    const settingsPanel = document.querySelector("settings-panel");

    document.querySelector("#restart-conversation").addEventListener("click", () => {
        settingsPanel.removeAttribute("open");

        // 編集モードの間はイベントを止めてある（trial.setEditing を参照）。
        // 押しても何も起きないので、黙って無視すると壊れたように見える。
        // 代わりに、そのモードでの試し方を知らせる
        if (runner.isPaused) {
            dialog.alert(
                "編集モードの間は、イベントが起きません。\n\n"
                    + "動きを確かめるときは、ブロックをクリックしてください。"
                    + "つながっているブロックは、上から順にまとめて動きます。"
                    + "実行中にもう一度クリックすると止まります。\n\n"
                    + "はじめから実行するときは、会話モードに切り替えてください。",
                {title: "編集モードです", icon: ICONS.info, okText: "閉じる"});
            return;
        }
        startConversation();
    });

    document.querySelector("#clear-history").addEventListener("click", () => {
        settingsPanel.removeAttribute("open");
        chatClient.clearHistory();
        chatFlow.clearMessages();
    });

    // 謝辞。読むだけなのでメニューは開いたままにする
    document.querySelector("#show-acknowledgment")
        .addEventListener("click", () => showAcknowledgment());
    document.querySelector("#show-model-info")
        .addEventListener("click", () => showModelInfo(avatar));

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
            avatar, emote, chatFlow, speechSynthesizer, sounds, voices, background, toast,
            conversation, signal
        }),
        // アクションが終わったら入力待ちへ移す。
        //
        // ready をここに入れているのは、あいさつを喋り終えてから待機の仕草を
        // 始めるため。イベントを出した時点で待機へ入れると、アクションは
        // async なので最初の await で制御が戻り、喋っている最中に待機の
        // 仕草が動き出してモーションがぶつかる
        onSettled: (type) => {
            if (type === "listenend" || type === "ready") {
                conversation.enterIdle();
            }
        }
    });

    const actionsRegistered = registerActions(runner, avatarActions);

    /**
     * 会話を始める（始め直す）。
     *
     * 待機へ入るのは「準備ができたとき」のアクションが終わってからなので、
     * そのアクションが登録されていないと誰も待機へ移してくれない。
     * その場合は ready を飛ばして直接待機へ入る。
     *
     * 見た目は読み込んだ直後の状態へ戻す。表情や視線は、ブロックで変えたら
     * ブロックで戻す作りなので、戻し忘れたまま「はじめから」を押すと、
     * 前の続きの顔で始まってしまう
     *
     * @param {boolean} [fireReady] 「準備ができたとき」から動かすか
     */
    const startConversation = (fireReady = true) => {
        avatar.clearExpressions();
        avatar.gazeFollowCamera();
        conversation.restart(fireReady && runner.types.includes("ready"));
    };

    //----------------------------------
    // ブロック編集画面
    //
    // 開くのは設定ウインドウから、閉じるのは編集画面から。編集のたびに
    // 設定を開き直さずに済む。#edit を付けた URL でも開いた状態で始められる
    //----------------------------------
    const blockEditor = createBlockEditor({
        actionsUrl: ACTIONS_URL,
        /*
          ドロップダウンの中身が揃うまでの合図。

          編集画面はブロックの定義を「最初に開いたとき 1 回だけ」作るので、
          その時点で一覧が空だと、空のまま焼き付く（保存済みの選択も外れる）。
          待つのは定義ファイルを読むところまでで、モデルの読み込みは待たない
        */
        namesReady: Promise.all([
            motionsRead, emote.iconsReady, soundsLoaded, voicesLoaded, backgroundsLoaded
        ]).catch((error) => console.warn("一覧を読み込めませんでした", error)),
        getNames: () => ({
            motionChoices,
            emoteChoices: emote.emoteChoices,
            soundChoices: sounds.choices,
            backgroundChoices: background.choices,
            voiceChoices: voices.choices
        }),
        // 組んだ内容で動かす。会話モードへ戻るたびに呼ばれる。
        // 保存とは切り離してある（どこかへ残すかは編集画面の「ファイル」の仕事）
        onApply: async (program) => {
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
                // 出しっぱなしのメッセージも消す（止めた後に残り続けない）
                Toast.dismiss();
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
                    // 待機へ入り直すだけ。編集中に中断したままだと
                    // 「待機に入ったとき」が二度と動かない。
                    //
                    // 「準備ができたとき」からやり直したいときは、メニューの
                    // 「はじめから実行」を押してもらう。モードの切り替えと
                    // プログラムの開始は別の操作にしてある
                    startConversation(false);
                }
            }
        }
    });

    document.querySelector("#open-editor").addEventListener("click", () => {
        settingsPanel.removeAttribute("open");
        blockEditor.open();
    });

    // 編集は誰でもできる。サーバへ公開できるかどうかだけが、合言葉の設定で
    // 決まる（編集画面の「ファイル」から公開したときに、サーバが判断する）
    document.querySelector("#editor-section").hidden = false;
    if (location.hash === "#edit") {
        blockEditor.open();
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
    // モーション・エモート・効果音・背景の読み込みを先に済ませるのは、ready の
    // アクションから、すぐ playMotion() や showEmote() を呼べるようにするため。
    // モーション以外は失敗しても続ける（無くても会話はできる）
    avatar.ready
        .then(() => Promise.all([
            motionsRead
                .then((motions) => registerMotions(avatar, motions))
                // 読み込めなかったものは選択肢から外す（一覧は先に出してある）
                .then((loaded) => {
                    motionChoices = loaded;
                }),
            emote.ready.catch(() => {}),
            soundsLoaded,
            voicesLoaded,
            backgroundsLoaded
        ]))
        // アクションの登録を待ってから ready を出す。
        // そうしないと最初のイベントを取りこぼす
        .then(() => actionsRegistered)
        .then(() => startConversation())
        .catch((error) => console.warn(error));
});


