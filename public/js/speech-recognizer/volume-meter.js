
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

const VolumeMeter = (() => {
    let audioContext = null
    let stream = null;
    let mediaStreamSource = null;
    let gainNode = null;
    let processorNode = null;

    // startAudio() / stopAudio() のたびに増やす。マイクが開くのを待つ間に
    // 止められたかを見分けるため（止められた後に開いたマイクは、すぐ閉じる）
    let generation = 0;

    let onvolumechangeHandler = null;
    let volume = 0;
    const averaging = 0.95;

    const onAudioMeterProcess = (event) => {
        const buf = event.inputBuffer.getChannelData(0);
        const bufLength = buf.length;
        let sum = 0;
        let x;

        for (let i = 0; i < bufLength; i++) {
            x = buf[i];
            sum += x * x;
        }
        const rms = Math.sqrt(sum / bufLength);
        volume = Math.max(rms, volume * averaging);
        
        if (onvolumechangeHandler) {
            //console.log(volume);
            onvolumechangeHandler(volume * 250);
        }
    };

    /** マイクを閉じ、次の startAudio() で開き直させる。 */
    const releaseMic = () => {
        stream?.getTracks().forEach((track) => track.stop());
        stream = null;
        mediaStreamSource = null;
        gainNode = null;
        processorNode = null;
    };

    return {
        startAudio: async (context) => {
            const current = ++generation;
            audioContext = context;

            if (audioContext.state !== "running") {
                await audioContext.resume();
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
                gainNode = audioContext.createGain();
                // TODO: ScriptProcessorNode is deprecated. need to use AudioWorklet.
                processorNode = audioContext.createScriptProcessor(512); // ScriptProcessorNode
                //processorNode.onaudioprocess = onAudioMeterProcess;
            }

            if (current !== generation) {
                return; // resume() を待つ間に止められた
            }
            gainNode.gain.value = 1; // [-3.4, 3.4]

            processorNode.onaudioprocess = onAudioMeterProcess;
            mediaStreamSource.connect(gainNode);
            gainNode.connect(processorNode);
            processorNode.connect(audioContext.destination);
        },
        stopAudio: () => {
            ++generation; // マイクが開くのを待っている startAudio() があれば、取りやめさせる

            // if (audioContext) {
            //     audioContext.suspend();
            // }
            if (processorNode) {
                processorNode.disconnect();
            }
            if (gainNode) {
                gainNode.disconnect();
            }
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
