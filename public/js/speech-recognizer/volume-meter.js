
// 聞き終えた後も、音量を測るためのマイクを開いたままにするか。
// 音声認識（Web Speech API）のマイクとは別物で、こちらは音量表示のためだけに開いている。
//
//   true  開いたまま（既定）
//         2 回目からはマイクを開き直さないので、音量がすぐ表示される。
//         ただし録音中の表示が消えず、Bluetooth のヘッドセットは通話用の方式
//         （こもった音）のままになる。Google Meet など、ほかのアプリと
//         マイクを取り合って不具合が出ることもある
//
//   false 聞き終えるたびに閉じる
//         聞いていない間はマイクを使わない。そのぶん音量の表示がわずかに遅れ、
//         Bluetooth のヘッドセットは聞くたびに通話用と音楽用を行き来する
//         （切り替えの間、音が途切れることがある）
const KEEP_MIC_OPEN = true;

// 音量（0〜1 ほど）を、インジケーターの値（0〜100）に直す倍率
const LEVEL_SCALE = 250;

// 音量を測る処理（音声処理のスレッドで動く）。読み込むページの場所によらず
// 見つかるよう、このファイルからの相対で指定する
const PROCESSOR_URL = new URL("./volume-meter-processor.js", import.meta.url);

const VolumeMeter = (() => {
    let audioContext = null;
    let stream = null;
    let mediaStreamSource = null;

    // 音量を測るノード。AudioContext ごとに一度だけ作り、使い回す
    let meterNode = null;
    let meterContext = null;

    // startAudio() / stopAudio() のたびに増やす。マイクが開くのを待つ間に
    // 止められたかを見分けるため（止められた後に開いたマイクは、すぐ閉じる）
    let generation = 0;

    let onvolumechangeHandler = null;

    // 測っている最中か。止めた後に届いた値は捨てる（表示を消した後で
    // 古い値が届くと、インジケーターが戻ってしまう）
    let measuring = false;

    /** マイクを閉じ、次の startAudio() で開き直させる。 */
    const releaseMic = () => {
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
        mediaStreamSource = null;
    };

    /** 音量を測るノードを用意する（この AudioContext で初めてなら作る）。 */
    const prepareMeter = async (context) => {
        if (meterNode && meterContext === context) {
            return meterNode;
        }
        await context.audioWorklet.addModule(PROCESSOR_URL);
        // 出力は持たせない（測るだけで、音は出さない）
        const node = new AudioWorkletNode(context, "volume-meter", {numberOfOutputs: 0});
        node.port.onmessage = ({data}) => {
            if (measuring) {
                onvolumechangeHandler?.(data * LEVEL_SCALE);
            }
        };
        meterNode = node;
        meterContext = context;
        return node;
    };

    return {
        startAudio: async (context) => {
            const current = ++generation;
            audioContext = context;

            if (audioContext.state !== "running") {
                await audioContext.resume();
            }

            let node;
            try {
                node = await prepareMeter(audioContext);
            } catch (error) {
                console.error(error);
                return; // 音量は出せないが、認識そのものは続けられる
            }

            // マイクが閉じていれば開く。開いたままにする設定なら、2 回目からは開いている
            if (! stream) {
                if (! (navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
                    return;
                }
                let opened;
                try {
                    opened = await navigator.mediaDevices.getUserMedia({audio: true});
                } catch (error) {
                    console.error(error);
                    return; // 音量は出せないが、認識そのものは続けられる
                }
                if (current !== generation) {
                    // 開くのを待つ間に止められた。使わないので、すぐ閉じる
                    opened.getTracks().forEach((track) => track.stop());
                    return;
                }
                stream = opened;
                mediaStreamSource = audioContext.createMediaStreamSource(stream);
            }

            if (current !== generation) {
                return; // 準備を待つ間に止められた
            }
            node.port.postMessage("reset");
            mediaStreamSource.connect(node);
            measuring = true;
        },
        stopAudio: () => {
            ++generation; // マイクが開くのを待っている startAudio() があれば、取りやめさせる

            // 測るのをやめる（表示は呼び出し側が消す）
            measuring = false;
            if (mediaStreamSource) {
                mediaStreamSource.disconnect();
            }
            // 配線を外しても、マイクは開いたまま。閉じるには track.stop() が要る
            if (! KEEP_MIC_OPEN) {
                releaseMic();
            }
        },
        set onvolumechange(handler) {
            onvolumechangeHandler = handler;
        }
    };
})();


export default VolumeMeter;
