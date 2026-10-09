/**
 * 音声認識（Web Speech API）に、マイクではなく自前の音（MediaStreamTrack）を
 * 渡せるかを確かめる。連続対話は、これができるブラウザでだけ使える。
 *
 *   const {supported, reason} = await checkTrackSupport();
 *
 * W3C の草案では SpeechRecognition.start(audioTrack) で音を渡せるが、
 * 対応していないブラウザは引数を無視してマイクから聞く（エラーにならない）。
 * そのため「呼べたか」では見分けられず、実際に音を流して確かめる。
 *
 *   1. 映像のトラックを渡す。対応していれば、仕様どおり InvalidStateError に
 *      なる。ならなければ未対応（Safari 26 など。引数を無視してマイクで聞く）
 *   2. 決まった声（track-test.mp3、「おはようございます！」）をトラックに流し、
 *      その言葉が返ってくるかを見る。Edge は、受け取っても結果が空になる
 *      ことがあるので、1 だけでは足りない
 *
 * 声は 16 kHz で作り、前後には無音を流し続ける（連続対話で実際に流すのと
 * 同じ条件にする）。Edge は 48 kHz では結果が空になり、Chrome・Edge とも、
 * 無音が届かないと「話し終えた」と判断できず、結果が確定しない。
 *
 * 2 は認識サーバーとやり取りするので、数秒かかる。結果はブラウザごとに
 * 覚えておく（readCachedTrackSupport()）。1 で未対応と分かったときは、
 * 一瞬マイクで聞き始めてしまうので、すぐ止める。
 */

// 試すときに流す声と、返ってきた言葉に含まれているべき文字
const TEST_AUDIO_URL = new URL("./track-test.mp3", import.meta.url);
const EXPECTED_WORD = "おはよう";

// 連続対話で音を作るのと同じサンプルレート
const SAMPLE_RATE = 16000;

// 認識が聞き始めてから声を流すまでの間（秒）
const LEAD_IN = 0.5;

// これだけ待っても結果が返らなければ、使えないものとみなす（ミリ秒）
const TIMEOUT_MS = 10000;

// 結果を覚えておく localStorage のキー
const CACHE_KEY = "vrmtalker.speech-track-support";

const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;


/**
 * 前に確かめた結果。同じブラウザ（User-Agent が同じ）で確かめたものだけを返す。
 * ブラウザを更新すると対応が変わりうるので、User-Agent が違えば無かったことにする。
 *
 * @returns {{supported: boolean, reason: string}|null}
 */
export const readCachedTrackSupport = () => {
    try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
        if (cached && cached.userAgent === navigator.userAgent) {
            return {supported: Boolean(cached.supported), reason: String(cached.reason ?? "")};
        }
    } catch (error) {
        // 読めなければ、確かめていないものとして扱う
    }
    return null;
};

const writeCache = (result) => {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
            ...result, userAgent: navigator.userAgent, checkedAt: new Date().toISOString()
        }));
    } catch (error) {
        // 覚えられなくても、次にまた確かめるだけ
    }
};


/**
 * 音を渡せるかを確かめる。利用者の操作（クリックなど）を受けて呼ぶこと
 * （AudioContext を動かすため）。
 *
 * reason は、使えなかったわけ。調べる人向け（画面には出さず、コンソールに出す）
 *
 * @param {object} [options]
 * @param {string} [options.lang] 認識する言語
 * @returns {Promise<{supported: boolean, reason: string}>}
 */
export const checkTrackSupport = async ({lang = "ja-JP"} = {}) => {
    const result = await runCheck(lang);
    writeCache(result);
    return result;
};

const runCheck = async (lang) => {
    if (! SpeechRecognitionApi) {
        return {supported: false, reason: "このブラウザは音声認識に対応していません。"};
    }
    if (! rejectsVideoTrack()) {
        return {
            supported: false,
            reason: "start(track) の引数を無視する（マイクから直接聞く）。"
        };
    }
    try {
        const text = await recognizeTestAudio(lang);
        if (normalize(text).includes(EXPECTED_WORD)) {
            return {supported: true, reason: ""};
        }
        return {
            supported: false,
            reason: text
                ? `試しに流した声を、正しく聞き取れませんでした（「${text}」と認識）。`
                : "試しに流した声を、聞き取れませんでした。"
        };
    } catch (error) {
        return {supported: false, reason: `確かめている途中で失敗しました（${error.message}）。`};
    }
};

/**
 * 映像のトラックを渡して、仕様どおり InvalidStateError になるか。
 * ならなければ引数を無視してマイクで聞き始めているので、すぐ止める。
 */
const rejectsVideoTrack = () => {
    const canvas = document.createElement("canvas");
    if (typeof canvas.captureStream !== "function") {
        return true; // 確かめられない。次の、実際に流す試しに任せる
    }
    const track = canvas.captureStream().getVideoTracks()[0];
    const recognition = new SpeechRecognitionApi();
    try {
        recognition.start(track);
    } catch (error) {
        return error.name === "InvalidStateError";
    } finally {
        track.stop();
    }
    recognition.abort();
    return false;
};

/**
 * 決まった声をトラックに流して認識させ、返ってきた言葉を返す。
 * 返ってこなければ空文字。
 */
const recognizeTestAudio = async (lang) => {
    const context = new AudioContext({sampleRate: SAMPLE_RATE});
    let track = null;
    try {
        await context.resume();
        const response = await fetch(TEST_AUDIO_URL);
        if (! response.ok) {
            throw new Error(`試験用の声を読み込めません（${response.status}）`);
        }
        const buffer = await context.decodeAudioData(await response.arrayBuffer());

        // 値が 0 の音を流し続け、声の前後にも無音が届くようにする
        const destination = context.createMediaStreamDestination();
        const silence = context.createConstantSource();
        silence.offset.value = 0;
        silence.connect(destination);
        silence.start();
        track = destination.stream.getAudioTracks()[0];

        const recognition = new SpeechRecognitionApi();
        recognition.lang = lang;
        recognition.continuous = false;
        recognition.interimResults = false;

        const text = await new Promise((resolve, reject) => {
            let heard = "";
            const timer = setTimeout(() => {
                recognition.abort();
                resolve(heard);
            }, TIMEOUT_MS);
            recognition.onresult = (event) => {
                const result = event.results[event.results.length - 1];
                if (result.isFinal) {
                    heard = result[0].transcript;
                }
            };
            recognition.onend = () => {
                clearTimeout(timer);
                resolve(heard);
            };
            try {
                recognition.start(track);
            } catch (error) {
                clearTimeout(timer);
                reject(error);
                return;
            }

            const voice = context.createBufferSource();
            voice.buffer = buffer;
            voice.connect(destination); // スピーカーには出さない
            voice.start(context.currentTime + LEAD_IN);
        });

        return text;
    } finally {
        track?.stop();
        await context.close();
    }
};

/** 比べるために、空白と句読点・記号を取り除く。 */
const normalize = (text) => String(text).replace(/[\s、。！？!?.,]/g, "");
