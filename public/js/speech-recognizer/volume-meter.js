
const VolumeMeter = (() => {
    let audioContext = null
    let stream = null;
    let mediaStreamSource = null;
    let gainNode = null;
    let processorNode = null;

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

    return {
        startAudio: async (context) => {
            audioContext = context;

            if (audioContext.state !== "running") {
                await audioContext.resume();
            }

            if (! processorNode) {
                if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                    try {
                        stream = await navigator.mediaDevices.getUserMedia({audio: true});
                        mediaStreamSource = audioContext.createMediaStreamSource(stream);
                        gainNode = audioContext.createGain();
                        // TODO: ScriptProcessorNode is deprecated. need to use AudioWorklet.
                        processorNode = audioContext.createScriptProcessor(512); // ScriptProcessorNode 
                        //processorNode.onaudioprocess = onAudioMeterProcess;
                    } catch (error) {
                        console.error(error);
                    }
                }
            }
            gainNode.gain.value = 1; // [-3.4, 3.4]

            processorNode.onaudioprocess = onAudioMeterProcess;
            mediaStreamSource.connect(gainNode);
            gainNode.connect(processorNode);
            processorNode.connect(audioContext.destination);
        },
        stopAudio: () => {
            // if (audioContext) {
            //     audioContext.suspend();
            // }
            if (processorNode) {
                processorNode.disconnect();
                processorNode.onvolumechangeHandler = null;
            }
            if (gainNode) {
                gainNode.disconnect();
            }
            if (mediaStreamSource) {
                mediaStreamSource.disconnect();
            }
            //stream.getTracks().forEach(track => track.stop());
            //stream.getAudioTracks()[0].stop();
        },
        set onvolumechange(handler) {
            onvolumechangeHandler = handler;
        }
    };
})();


export default VolumeMeter;
