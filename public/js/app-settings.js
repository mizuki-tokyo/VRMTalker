/**
 * 設定ウインドウの処理。
 *
 * 話者 / カメラの寄り / 吹き出しの色 / キャラクタの名前と性格 / 話しかけ方を扱い、
 * localStorage への保存と破棄を行う。
 *
 * 対話の骨格は app.js に置き、設定はここへ分けている。値をどこへ適用するか
 * （どの CSS 変数へ書くか、どのプロパティを差し替えるか）は設定側の関心事なので、
 * アプリのオブジェクトを受け取って直接書き換える。
 *
 *   setupSettings({
 *       avatar, world, chatFlow, chatClient, speechSynthesizer,
 *       onSpeakerChange: (speaker) => { ... }
 *   });
 *
 * 話者だけはコールバックで返す。VOICEVOX の利用規約で必要なクレジット表記は
 * 設定ウインドウではなく常時表示の要素なので、app.js 側に残してある。
 */

import dialog from "./web-ui/dialog.js";
import {checkTrackSupport, readCachedTrackSupport}
    from "./speech-hands-free/track-support.js";

// localStorage のキー
const SETTINGS_KEY = "vrmtalker.settings";

// カメラの寄り。スライダーの両端に対応する距離
const ZOOM_NEAREST = 0.6;   // スライダー最大のとき（大きく見える）
const ZOOM_FARTHEST = 6.0;  // スライダー最小のとき（小さく見える）

// 吹き出しの背景の既定の不透明度
const BUBBLE_FILL_ALPHA = 0.92;

// 保存・破棄したことが分かるようチェックアイコンを出しておく時間
const FLASH_DONE_MS = 1200;


/**
 * localStorage は容量超過やプライベートモードで例外を投げるため、
 * 読み書きは必ず包む。保存できなくてもアプリは動き続ける。
 */
const readStoredSettings = () => {
    try {
        return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || null;
    } catch (error) {
        console.warn("保存された設定を読み込めませんでした", error);
        return null;
    }
};


/**
 * @param {object}   deps
 * @param {Element}  deps.avatar            <vrm-avatar>
 * @param {Element}  deps.world             <three-world>
 * @param {Element}  deps.chatFlow          <chat-flow>
 * @param {object}   deps.chatClient        ChatClient
 * @param {object}   deps.speechSynthesizer SpeechSynthesizer
 * @param {(speaker: object) => void} [deps.onSpeakerChange] 話者が決まったとき
 * @param {(enabled: boolean) => void} [deps.onHandsFreeChange] 連続対話を
 *        オン・オフしたとき（使えるかを確かめた後に呼ぶ）
 */
const setupSettings = ({
    avatar, world, chatFlow, chatClient, speechSynthesizer,
    onSpeakerChange = () => {},
    onHandsFreeChange = () => {}
}) => {

    const storedSettings = readStoredSettings();

    //----------------------------------
    // 話者
    //----------------------------------

    // 既定の話者。破棄したときに戻す先として、書き換わる前に控えておく
    const DEFAULT_STYLE_ID = speechSynthesizer.styleId;

    const speakerSelect = document.querySelector("#speaker-select");

    // 話者一覧を取得する前に呼ばれても良いよう関数にしておく
    let applyStyleId = (styleId) => {
        speechSynthesizer.styleId = styleId;
    };

    speechSynthesizer.getSpeakers()
        .then((speakers) => {
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

                const speaker = speakers.find((s) => s.style_id === applied);
                if (speaker) {
                    onSpeakerChange(speaker);
                }
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

    //----------------------------------
    // キャラクタの大きさ（カメラの寄り具合）
    //
    // <chat-flow> が画面を覆っていてホイール操作が届かないため、
    // スライダーでカメラと注視点の距離を変える
    //----------------------------------
    const zoomSlider = document.querySelector("#zoom-slider");

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
    // キャラクタの名前と性格
    //
    // 名前の既定値は VRM のモデル名。値ではなく placeholder に入れるので、
    // 空欄＝既定、と区別できる（「破棄」で空に戻せば既定に戻る）
    //----------------------------------
    const characterNameInput = document.querySelector("#character-name");
    const characterProfileInput = document.querySelector("#character-profile");

    let modelName = "";

    /** 入力内容を chatClient へ渡す。空欄ならモデル名を名前に使う */
    const applyPersona = () => {
        chatClient.persona = {
            name: characterNameInput.value.trim() || modelName,
            profile: characterProfileInput.value.trim()
        };
    };

    // 入力のたびではなく、確定したときに反映する
    characterNameInput.addEventListener("change", applyPersona);
    characterProfileInput.addEventListener("change", applyPersona);

    characterNameInput.value = storedSettings?.persona?.name ?? "";
    characterProfileInput.value = storedSettings?.persona?.profile ?? "";

    avatar.ready
        .then(() => {
            const meta = avatar.humanoid.getMeta();
            // VRM 1.0 は name、VRM 0.x は title
            modelName = meta?.name || meta?.title || "";
            characterNameInput.placeholder = modelName || "（名称なし）";
            // モデル名が確定してから渡す（名前が空欄のときの既定になるため）
            applyPersona();
        })
        .catch(() => {
            characterNameInput.placeholder = "読み込めませんでした";
        });

    // モデルの読み込みを待たずに、保存済みの設定は先に反映しておく
    applyPersona();

    //----------------------------------
    // 話しかけ方（連続対話）
    //
    // 連続対話は、音声認識に音を渡せるブラウザでだけ使える。オンにしようと
    // したときに確かめ、使えなければオフに戻して知らせる（確かめるには
    // 音を鳴らすので、利用者の操作を受けてから行う）。確かめた結果は
    // ブラウザごとに覚えておき、次からは確かめ直さない
    //----------------------------------
    const handsFreeCheckbox = document.querySelector("#hands-free");
    const handsFreeNote = document.querySelector("#hands-free-note");

    const HANDS_FREE_NOTES = {
        off: "オフのときは、マイクのボタンを押すたびに 1 回聞き取ります。",
        on: "マイクのボタンで連続対話を始め、もう一度押すと終わります。"
              + "話しかけるたびに聞き取ります。",
        checking: "このブラウザで使えるかを確かめています…",
        // 理由は利用者には伝わりにくく、同じ Chrome・Edge でも環境で結果が変わりうるので、
        // 画面には出さない（コンソールに出す）
        unsupported: "このブラウザは対応していませんでした。他のブラウザでお試しください。"
    };

    const applyHandsFree = (enabled, note) => {
        handsFreeCheckbox.checked = enabled;
        handsFreeNote.textContent = note ?? (enabled ? HANDS_FREE_NOTES.on : HANDS_FREE_NOTES.off);
        onHandsFreeChange(enabled);
    };

    handsFreeCheckbox.addEventListener("change", async () => {
        if (! handsFreeCheckbox.checked) {
            applyHandsFree(false);
            return;
        }
        // 前に使えると分かっていれば、確かめ直さない
        if (readCachedTrackSupport()?.supported) {
            applyHandsFree(true);
            return;
        }
        handsFreeCheckbox.disabled = true;
        handsFreeNote.textContent = HANDS_FREE_NOTES.checking;
        const {supported, reason} = await checkTrackSupport();
        handsFreeCheckbox.disabled = false;
        if (! supported) {
            console.info("連続対話は使えません:", reason);
        }
        applyHandsFree(supported, supported ? undefined : HANDS_FREE_NOTES.unsupported);
    });

    // 保存されていても、使えると確かめた結果が無ければオンにしない
    // （ブラウザを更新した後など。確かめるには利用者の操作が要る）
    if (storedSettings?.handsFree && readCachedTrackSupport()?.supported) {
        applyHandsFree(true);
    } else {
        applyHandsFree(false, storedSettings?.handsFree
            ? "このブラウザで使えるかを確かめ直すため、連続対話をオフにしました。"
              + "使うには、もう一度オンにしてください。"
            : undefined);
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
        }, FLASH_DONE_MS);
    };

    saveButton.addEventListener("click", () => {
        const settings = {
            zoom: Number(zoomSlider.value),
            styleId: speechSynthesizer.styleId,
            colors: Object.fromEntries(bubbleColorSettings.map((setting) =>
                [setting.id, document.querySelector(`#${setting.id}`).value])),
            // 入力欄の値をそのまま保存する。名前が空欄なら「モデル名を使う」の意味
            persona: {
                name: characterNameInput.value.trim(),
                profile: characterProfileInput.value.trim()
            },
            handsFree: handsFreeCheckbox.checked
        };
        try {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
            flashDone(saveButton);
        } catch (error) {
            // 容量超過やプライベートモードなど。保存できなくても動作は続ける
            console.warn("設定を保存できませんでした", error);
            dialog.alert("設定を保存できませんでした。", {title: "保存に失敗しました"});
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

        // 空欄に戻す。名前は placeholder のモデル名が既定として使われる
        characterNameInput.value = "";
        characterProfileInput.value = "";
        applyPersona();

        applyHandsFree(false);

        // 会話履歴には元の性格での応答が残る。消すかどうかは利用者に任せる
        flashDone(resetButton);
    });
};

export default setupSettings;
