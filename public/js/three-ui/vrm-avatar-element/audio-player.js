
const agent = window.navigator.userAgent.toLowerCase();
const isSafari = (agent.indexOf("safari") >= 0 && agent.indexOf("chrome") === -1);

//====================================================================================================
// 母音推定 (LPC によるフォルマント分析)
//
// 時間波形 → プリエンファシス → ハミング窓 → 自己相関 → Levinson-Durbin → LPC スペクトル包絡
// → ピーク検出 → F1/F2 → 参照フォルマントとの距離で母音を推定
//====================================================================================================

// 日本語 5 母音の参照フォルマント値 (Hz)
const VOWEL_FORMANTS = Object.freeze({
    // 成人男性 (低め) 用モデル
    male: Object.freeze({
        a: {f1: 775, f2: 1163},
        i: {f1: 263, f2: 2263},
        u: {f1: 363, f2: 1300},
        e: {f1: 475, f2: 1738},
        o: {f1: 550, f2:  838}
    }),
    // 成人女性 (高め) 用モデル
    female: Object.freeze({
        a: {f1: 888, f2: 1363},
        i: {f1: 325, f2: 2725},
        u: {f1: 375, f2: 1675},
        e: {f1: 483, f2: 2317},
        o: {f1: 483, f2:  925}
    })
});

const VOWELS = Object.freeze(["a", "i", "u", "e", "o"]);

const FFT_SIZE = 4096;          // フォルマント分析には十分な分解能が必要
const SPECTRUM_SIZE = 1024;     // LPC スペクトル包絡の点数
const LPC_ORDER_DIVISOR = 550;  // LPC 次数 = サンプリング周波数 / この値
const PEAK_THRESHOLD = 0.05;    // 最大ピークに対する相対的な検出しきい値
const PEAK_MERGE_HZ = 120;      // この間隔以内のピークは 1 つにまとめる
const PEAK_MIN_HZ = 150;
const PEAK_MAX_HZ = 4000;
const FORMANT_SMOOTHING = 0.7;  // 前回のフォルマント値を残す割合

// プリエンファシス（高域を持ち上げて声道特性を取り出しやすくする）
const preEmphasis = (source, dest) => {
    dest[0] = 0;
    for (let i = 1; i < source.length; i++) {
        dest[i] = source[i] - 0.97 * source[i - 1];
    }
};

const applyWindow = (source, window, dest) => {
    for (let i = 0; i < source.length; i++) {
        dest[i] = source[i] * window[i];
    }
};

const autocorrelate = (x, order, dest) => {
    for (let i = 0; i <= order; i++) {
        let sum = 0;
        for (let j = 0; j < x.length - i; j++) {
            sum += x[j] * x[j + i];
        }
        dest[i] = sum;
    }
};

// Levinson-Durbin 法で LPC 係数を求める
const levinson = (r, order, dest, work) => {
    dest.fill(0);
    work.fill(0);

    let e = r[0];
    for (let i = 1; i <= order; i++) {
        let lambda = r[i];
        for (let j = 1; j < i; j++) {
            lambda -= dest[j] * r[i - j];
        }
        if (Math.abs(e) < 1e-10) {
            break;
        }
        lambda /= e;
        for (let j = 1; j < i; j++) {
            work[j] = dest[j] - lambda * dest[i - j];
        }
        work[i] = lambda;
        for (let j = 1; j <= i; j++) {
            dest[j] = work[j];
        }
        e *= (1 - lambda * lambda);
        if (e <= 0) {
            break;
        }
    }
};

// LPC 係数から振幅スペクトル包絡を求める
const computeSpectrum = (lpc, n, dest) => {
    const order = lpc.length - 1;

    for (let i = 0; i < n; i++) {
        const w = Math.PI * i / n;
        const cosW = Math.cos(w);
        const sinW = Math.sin(w);

        // cos(k*w) / sin(k*w) は漸化式で更新する（毎回 Math.cos を呼ぶと重い）
        let cosK = 1;
        let sinK = 0;
        let re = 1;
        let im = 0;

        for (let k = 1; k <= order; k++) {
            const nextCos = cosK * cosW - sinK * sinW;
            const nextSin = cosK * sinW + sinK * cosW;
            cosK = nextCos;
            sinK = nextSin;

            re -= lpc[k] * cosK;
            im += lpc[k] * sinK;
        }
        const mag2 = re * re + im * im;
        dest[i] = (mag2 > 1e-10) ? 1 / Math.sqrt(mag2) : 0;
    }
};

const findPeaks = (spectrum, sampleRate) => {
    const n = spectrum.length;
    const nyquist = sampleRate / 2;

    let maxValue = 0;
    for (let i = 0; i < n; i++) {
        if (spectrum[i] > maxValue) {
            maxValue = spectrum[i];
        }
    }
    const threshold = maxValue * PEAK_THRESHOLD;

    const minIndex = Math.floor(PEAK_MIN_HZ / nyquist * n);
    const maxIndex = Math.floor(PEAK_MAX_HZ / nyquist * n);

    const peaks = [];
    for (let i = minIndex + 2; i < maxIndex - 2; i++) {
        if (spectrum[i] > spectrum[i - 1] && spectrum[i] > spectrum[i + 1] &&
            spectrum[i] > spectrum[i - 2] && spectrum[i] > spectrum[i + 2] &&
            spectrum[i] > threshold) {
            peaks.push({freq: i * nyquist / n, amp: spectrum[i]});
        }
    }

    // 近接するピークをまとめる（周波数の低い順に並んでいる）
    const merged = [];
    for (const peak of peaks) {
        const last = merged[merged.length - 1];
        if (! last || peak.freq - last.freq > PEAK_MERGE_HZ) {
            merged.push(peak);
        } else if (peak.amp > last.amp) {
            merged[merged.length - 1] = peak;
        }
    }
    return merged;
};

/**
 * F1/F2 から母音を推定する。
 *
 * @returns {{vowel: string|null, confidence: number, dist: Object}}
 *   confidence は 0-1。5 母音が等距離のとき 0.2、特定の母音に近いほど 1 に近づく。
 */
const estimateVowel = (f1, f2, vowelFormants) => {
    const dist = {};
    if (f1 === 0 || f2 === 0) {
        for (const vowel of VOWELS) {
            dist[vowel] = 0;
        }
        return {vowel: null, confidence: 0, dist};
    }

    let bestVowel = null;
    let bestWeight = 0;
    let totalWeight = 0;

    for (const vowel of VOWELS) {
        const reference = vowelFormants[vowel];
        const f1Diff = f1 - reference.f1;
        const f2Diff = f2 - reference.f2;
        const distance = Math.sqrt(f1Diff * f1Diff + f2Diff * f2Diff);
        dist[vowel] = distance;

        // 距離が近いほど大きくなる重み
        const weight = 1 / (distance + 1);
        totalWeight += weight;
        if (weight > bestWeight) {
            bestWeight = weight;
            bestVowel = vowel;
        }
    }

    return {
        vowel: bestVowel,
        confidence: (totalWeight > 0) ? bestWeight / totalWeight : 0,
        dist
    };
};

/**
 * AnalyserNode から取り出した時間波形を解析して、母音と音量を返す。
 * 作業用バッファは使い回す（毎フレーム確保すると GC の負荷になる）。
 */
const createFormantAnalyzer = (analyserNode, sampleRate) => {
    const fftSize = analyserNode.fftSize;
    const lpcOrder = Math.floor(sampleRate / LPC_ORDER_DIVISOR);

    const timeData = new Float32Array(fftSize);
    const emphasized = new Float32Array(fftSize);
    const windowed = new Float32Array(fftSize);
    const autocorrelation = new Float32Array(lpcOrder + 1);
    const lpc = new Float32Array(lpcOrder + 1);
    const lpcWork = new Float32Array(lpcOrder + 1);
    const spectrum = new Float32Array(SPECTRUM_SIZE);

    // ハミング窓は不変なので一度だけ計算する
    const hammingWindow = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
        hammingWindow[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (fftSize - 1));
    }

    let vowelFormants = VOWEL_FORMANTS.male;
    let smoothF1 = null;
    let smoothF2 = null;

    return {
        set voiceType(type) {
            vowelFormants = VOWEL_FORMANTS[type] || VOWEL_FORMANTS.male;
        },

        reset() {
            smoothF1 = null;
            smoothF2 = null;
        },

        analyze() {
            analyserNode.getFloatTimeDomainData(timeData);

            let sum = 0;
            for (let i = 0; i < timeData.length; i++) {
                sum += timeData[i] * timeData[i];
            }
            const rms = Math.sqrt(sum / timeData.length);

            preEmphasis(timeData, emphasized);
            applyWindow(emphasized, hammingWindow, windowed);
            autocorrelate(windowed, lpcOrder, autocorrelation);
            levinson(autocorrelation, lpcOrder, lpc, lpcWork);
            computeSpectrum(lpc, SPECTRUM_SIZE, spectrum);

            const peaks = findPeaks(spectrum, sampleRate);
            const newF1 = (peaks.length >= 1) ? peaks[0].freq : null;
            const newF2 = (peaks.length >= 2) ? peaks[1].freq : null;

            // フォルマントが飛び跳ねないよう平滑化する
            if (newF1 !== null) {
                smoothF1 = (smoothF1 === null) ? newF1
                    : smoothF1 * FORMANT_SMOOTHING + newF1 * (1 - FORMANT_SMOOTHING);
            }
            if (newF2 !== null) {
                smoothF2 = (smoothF2 === null) ? newF2
                    : smoothF2 * FORMANT_SMOOTHING + newF2 * (1 - FORMANT_SMOOTHING);
            }

            const f1 = smoothF1 || 0;
            const f2 = smoothF2 || 0;
            const result = estimateVowel(f1, f2, vowelFormants);
            result.f1 = f1;
            result.f2 = f2;
            result.rms = rms;
            return result;
        }
    };
};

const silentResult = () => ({
    vowel: null,
    confidence: 0,
    dist: {a: 0, i: 0, u: 0, e: 0, o: 0},
    f1: 0,
    f2: 0,
    rms: 0
});

//====================================================================================================
// AudioPlayer
//====================================================================================================
const AudioPlayer = function() {
    const ANALYZE_INTERVAL = 25;
    const TOUCH_TO_START_ELEMENT_ID = "__touch_to_start__";

    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    let controller = null;
    let isEnded = false;

    const analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = FFT_SIZE;

    const formantAnalyzer = createFormantAnalyzer(analyserNode, audioContext.sampleRate);

    let audioSourceNode = null;
    let mediaElementSourceNode = null;

    // 再生ごとに増やす通し番号。play() や decodeAudioData() の失敗は非同期に届くため、
    // 次の再生が始まった後に前の再生のエラーが来ることがある。それを取り違えないために使う
    let playGeneration = 0;

    /**
     * 再生を中断してエラーを通知する。
     *
     * isEnded を立てないと update() のポーリングが止まらず、
     * 完了通知も来ないため呼び出し側が永久に待ち続けることになる。
     *
     * @param {Error} error
     * @param {number} [generation] 発生元の再生番号。古い通知はここで捨てる
     */
    const failPlayback = (error, generation) => {
        if (generation !== undefined && generation !== playGeneration) {
            return; // 既に次の再生が始まっている。前の再生のエラーなので無視する
        }
        if (isEnded) {
            return; // 既に終了処理済み
        }
        isEnded = true;
        if (controller.onPlayError) {
            controller.onPlayError(error);
        } else {
            console.error(error);
        }
    };

    const createBufferSourceNode = () => {
        const audioSourceNode = audioContext.createBufferSource();
        audioSourceNode.onended = () => {
            isEnded = true;
        };
        return audioSourceNode;
    }

    const createMediaElementSourceNode = () => {
        const audio = new Audio();
        audio.loop = false;
        audio.autoplay = false;
        audio.crossOrigin = "anonymous";
        audio.addEventListener("ended", () => {
            isEnded = true;
            audio.pause();
        }, false);

        // 取得できない URL などで発生する。放置すると "ended" が来ないため、
        // update() のポーリングも完了通知も止まらなくなる
        audio.addEventListener("error", () => {
            const detail = audio.error ? `code=${audio.error.code}` : "unknown";
            failPlayback(new Error(`音声を再生できませんでした (${detail}): ${audio.src}`));
        }, false);

        if (isSafari) {
            // [Chrome]
            //   volume をゼロにすると audioContext.destination から音が出ない
            // [Safari]
            //   volume をゼロにしないと、audioContext.destination と未接続の状態でも
            //   Audio#play() 呼び出し直後に最初に一瞬音が出てしまう
            //   この音と audioContext.destination から出力される音が被るため、
            //   再生直後の一瞬は、違和感のある音になる
            //   この現象を防ぐため、Safari では  volume をゼロにする
            audio.volume = 0;
        }
        return audioContext.createMediaElementSource(audio); // mediaelement
    }

    const connect = () => {
        audioSourceNode.connect(analyserNode);
        analyserNode.connect(audioContext.destination); // sound out.
    };

    const disconnect = () => {
        audioSourceNode.disconnect();
        analyserNode.disconnect();
    };

    const update = () => {
        if (controller.onAnalyzed) {
            controller.onAnalyzed(formantAnalyzer.analyze());
        }

        if (isEnded === false) {
            setTimeout(() => {
                update();
            }, ANALYZE_INTERVAL);
        } else {
            if (controller.onAnalyzed) {
                controller.onAnalyzed(silentResult());
            }
            if (controller.onPlayEnd) {
                controller.onPlayEnd();
                disconnect();
            }
        }
    };

    const startUrlPlay = (url, generation) => {
        if (! mediaElementSourceNode) {
            mediaElementSourceNode = createMediaElementSourceNode();
        }
        const audio = mediaElementSourceNode.mediaElement;
        audio.src = url;
        audioSourceNode = mediaElementSourceNode;
        connect();

        formantAnalyzer.reset();
        if (controller.onPlayStart) {
            controller.onPlayStart();
        }
        update();

        // play() は再生できない場合に Promise を reject する。
        // 受けておかないと未処理の拒否になる（error イベントとは別経路）
        audio.play().catch((error) => {
            failPlayback(error, generation);
        });
    };

    const startBufferPlay = (buffer) => {
        // Note: AudioBufferSourceNode is not reusable. Create on every play.
        let bufferSourceNode = createBufferSourceNode();
        bufferSourceNode.buffer = buffer;
        audioSourceNode = bufferSourceNode;
        connect();

        formantAnalyzer.reset();
        if (controller.onPlayStart) {
            controller.onPlayStart();
        }
        update();

        audioSourceNode.start(0);
    }

    /**
     * The resource supports the following.
     *  - URL string
     *  - ArrayBuffer object
     *  - AudioBuffer object
     */
    const start = (resource) => {
        isEnded = false;
        const generation = ++playGeneration;

        if (typeof resource === "string") {
            startUrlPlay(resource, generation);

        } else if (resource.constructor === ArrayBuffer) {
            // ArrayBuffer -> AudioBuffer
            audioContext.decodeAudioData(resource)
                .then(audioBuffer => {
                    if (generation !== playGeneration) {
                        return; // 既に次の再生が始まっている
                    }
                    startBufferPlay(audioBuffer);
                })
                .catch(error => {
                    // ここで throw しても未処理の拒否になるだけで呼び出し側に届かない。
                    // onPlayError へ流し、待機している側を解放する
                    failPlayback(error, generation);
                });
        } else if (resource.constructor === AudioBuffer) {
            startBufferPlay(resource);
        } else {
            failPlayback(new Error(`対応していない型です: ${resource?.constructor?.name}`));
        }
    }


    //====================================================================================================
    // Touch To Start 画面を作成
    // AucioContext オブジェクト生成は、ボタン押下等のユーザ操作が発生したタイミングで行う必要がある。
    // ユーザ操作以外のタイミングで生成された場合、Touch To Start 画面を出して、画面をクリックさせる
    //====================================================================================================
    const createTouchToStartElement = () => {
        let size = 80; // ミュートアイコンのサイズ

        // Mute icon is CC-0 License.
        // see, https://www.svgrepo.com/svg/129402/mute
        const MUTE_ICON =`<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
     width="${size}" viewBox="0 0 496.159 496.159" style="enable-background:new 0 0 496.159 496.159;" xml:space="preserve">
<path style="fill:#E04F5F;" d="M496.159,248.086c0-137.022-111.07-248.082-248.076-248.082C111.071,0.004,0,111.063,0,248.086
	c0,137.001,111.07,248.07,248.083,248.07C385.089,496.155,496.159,385.086,496.159,248.086z"/>
<g>
	<path style="fill:#FFFFFF;" d="M259.432,128.917c-3.409-1.851-7.559-1.688-10.813,0.425l-95.137,61.791h-35.164
		c-5.845,0-10.583,4.738-10.583,10.582v92.728c0,5.845,4.738,10.583,10.583,10.583h35.164l95.137,61.79
		c1.748,1.135,3.754,1.708,5.765,1.708c1.733,0,3.471-0.426,5.049-1.283c3.41-1.852,5.534-5.42,5.534-9.301V138.219
		C264.966,134.339,262.842,130.768,259.432,128.917z"/>
	<path style="fill:#FFFFFF;" d="M355.405,248.079l30.384-30.384c3.515-3.516,3.515-9.213,0-12.729
		c-3.515-3.514-9.213-3.514-12.728,0l-30.384,30.385l-30.384-30.385c-3.515-3.514-9.213-3.514-12.728,0
		c-3.515,3.516-3.515,9.213,0,12.729l30.385,30.384l-30.384,30.384c-3.515,3.516-3.515,9.213,0,12.729
		c1.757,1.757,4.061,2.636,6.364,2.636c2.303,0,4.606-0.879,6.364-2.636l30.384-30.385l30.384,30.385
		c1.757,1.757,4.061,2.636,6.364,2.636c2.303,0,4.606-0.879,6.364-2.636c3.515-3.516,3.515-9.213,0-12.729L355.405,248.079z"/>
</g>
</svg>`;
        let messageElement = document.createElement("div");
        messageElement.innerHTML = `${MUTE_ICON}<span style="line-height:0;margin-left:8px;">画面をタップしてミュートを解除</span>`;

        messageElement.setAttribute("style", `position:fixed;top:50%;left:50%; transform:translate(-50%, -50%);`+
                                    `white-space:nowrap;color:white;font-size:24px;padding:10px;display:flex;align-items:center;`);

        // 画面を全て覆いつくす場合
        let coverElement = document.createElement("div");
        coverElement.setAttribute("style", `position:fixed;top:0px;left:0px;width:100vw;height:100vh;background:RGBA(100,100,100,0.8);`);
        coverElement.appendChild(messageElement);
        coverElement.setAttribute("id", TOUCH_TO_START_ELEMENT_ID);
        return coverElement;
    };


    controller = {
        play : (url) => {
            // ユーザ操作以外のタイミングで生成されたかを調べる
            if (audioContext.state === "suspended") {

                // ユーザ操作以外のタイミングで生成された場合、Touch To Start 画面を出して、画面をクリックさせる
                // AucioContext オブジェクト生成は、ボタン押下等のユーザ操作が発生したタイミングで行う必要がある。

                let touchToStartElement = document.getElementById(TOUCH_TO_START_ELEMENT_ID);
                if (touchToStartElement) {
                    touchToStartElement.onclick = null;
                    document.body.removeChild(touchToStartElement);
                }
                touchToStartElement = createTouchToStartElement();
                touchToStartElement.onclick = () => {
                    document.body.removeChild(touchToStartElement);
                    // TODO: resume() は非推奨だが、代替メソッドが不明 (resume() は未だ利用可能)
                    // https://developer.mozilla.org/ja/docs/Web/API/AudioContext

                    audioContext.resume()
                        .then(() => {
                            // リアルタイムに母音を推定しながら、オーディオを再生する
                            start(url);
                        });
                };
                document.body.appendChild(touchToStartElement);

            } else {
                // リアルタイムに母音を推定しながら、オーディオを再生する
                start(url);
            }
        },

        /** 母音推定に使う参照フォルマント。"male"（低め） または "female"（高め） */
        set voiceType(type) {
            formantAnalyzer.voiceType = type;
        },

        onPlayStart : undefined,
        /**
         * 解析結果の通知。
         * {vowel, confidence, dist, f1, f2, rms} を受け取る。
         *   vowel      : 推定した母音 "a"|"i"|"u"|"e"|"o"。判定できない場合は null
         *   confidence : 0-1。5 母音が等距離のとき 0.2
         *   rms        : 音量 (0-1 程度)
         */
        onAnalyzed : undefined,
        onPlayEnd : undefined,
        /**
         * 再生できなかったときの通知。Error を受け取る。
         *
         * 再生開始後のエラー（音声ファイルを取得できない等）では、
         * 接続の後始末のため、このあと onPlayEnd も呼ばれる。
         * 受け側は「先に来たほうを採用する」作りにしておくこと
         */
        onPlayError : undefined
    };

    return controller;
};

export default AudioPlayer;
export { VOWEL_FORMANTS, VOWELS };
