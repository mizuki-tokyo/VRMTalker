
const VolumeMeter = (() => {
    let audioContext = null;
    let audioSourceNode = null;
    let volumeMeterNode = null;

    let onvolumechange = null;
    let sensitivity = 200;
    //let count = 0;

    return {
        startAudio: async (context) => {
            if (! audioSourceNode) {
                audioContext = context;
                await audioContext.audioWorklet.addModule("./js/volume-meter-processor.js");
                const mediaStream = await navigator.mediaDevices.getUserMedia({audio: true});
                audioSourceNode = audioContext.createMediaStreamSource(mediaStream);
            }
            if (! volumeMeterNode) {
                volumeMeterNode = new AudioWorkletNode(audioContext, "volume-meter");
                volumeMeterNode.port.onmessage = ({data}) => {
                    //const value = Math.log10(data * sensitivity);
                    const value = (data * sensitivity);
                    // if (value > 100) {
                    //     if (++count > 10) {
                    //         sensitivity *= 0.9;
                    //         console.log(sensitivity);
                    //         count = 0;
                    //     }
                    // }
                    // if (value < 10) {
                    //     if (++count > 100) {
                    //         sensitivity *= 1.5;
                    //         console.log(sensitivity);
                    //         count = 0;
                    //     }
                    // }
                    onvolumechange(value);
                    //onvolumechange(data * sensitivity);
                };
            }

            //-----------
            //const gainNode = audioContext.createGain();
            //console.log("Gain: " + gainNode.gain.value);
            //gainNode.connect(audioContext.destination);
            //-----------

            audioSourceNode.connect(volumeMeterNode);
            volumeMeterNode.connect(audioContext.destination);
            audioContext.resume();
        },
        stopAudio: () => {
            if (audioContext) {
                audioContext.suspend();
            }
            if (audioSourceNode) {
                audioSourceNode.disconnect();
            }
            if (volumeMeterNode) {
                volumeMeterNode.disconnect();
            }
        },
        set onvolumechange(handler) {
            onvolumechange = handler;
        }
    };
})();

export default VolumeMeter;
