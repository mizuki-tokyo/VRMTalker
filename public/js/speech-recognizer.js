import VolumeMeter from "./volume-meter.js";
//import VolumeMeter from "./volume-meter-worklet.js";

let isChrome = false;
let isSafari = false;
(() => {
    const agent = window.navigator.userAgent.toLowerCase()
    if (agent.indexOf("chrome") != -1) {
        isChrome = true;
    } else if (agent.indexOf("safari") != -1) {
        isSafari = true;
    }
})();


const SpeechRecognition = window.SpeechRecognition || webkitSpeechRecognition;
//const SpeechGrammarList = window.SpeechGrammarList || webkitSpeechGrammarList;
const SpeechRecognitionEvent = window.SpeechRecognitionEvent || webkitSpeechRecognitionEvent;


class SpeechRecognizer {

    // Callback handler
    onsoundstart;
    onsoundsend;
    onvolumechange = (volume) => {console.log(volume)};
    onnomatch = (event) => {};
    onerror = (event) => {};
    onresult = (text, isFinal) => {};

    _recognition = null;
    _context = null;

    _setup() {
        this._recognition.onstart = (e) => {
        };
        this._recognition.onend = (e) => {
        };
        this._recognition.onaudiostart = (e) => {
            console.log("onaudiostart");

            VolumeMeter.onvolumechange = this.onvolumechange;
            VolumeMeter.startAudio(this._context);
        };
        this._recognition.onaudioend = (e) => {
            console.log("onaudioend");

            VolumeMeter.stopAudio();
            if (this.onvolumechange) {
                setTimeout(() => {
                    this.onvolumechange(0);
                }, 0);
            }
        };
        this._recognition.onspeechstart = (e) => {
            console.log("speechstart");
        };
        this._recognition.onspeechend = (e) => {
            console.log("speechend");
        };
        this._recognition.onsoundstart = (e) => {
            console.log("認識中");
        };
        this._recognition.onnomatch = (e) => {
            console.log("もう一度試してください");
            this.onnomatch(e);
        };
        this._recognition.onerror = (e) => {
            switch (e.error) {
            case "no-speech":
                break;
            case "audio-capture":
                break;
            case "not-allowed":
                break;
            default:
            }
            this.onerror(e);
            console.log("error");
        };
        this._recognition.onsoundend = (e) => {
            console.log("停止中");
        };
        this._recognition.onresult = (event) => {
            let transcript;
            const results = event.results;
            for (let i = event.resultIndex; i < results.length; i++) {
                if (results[i].isFinal === true) {
                    transcript = results[i][0].transcript;
                    this.onresult(transcript, true);
                    console.log(transcript);
                    document.querySelector("#speech-recognition-result").innerText = transcript;
                    
                    setTimeout(() => {
                        this._recognition.stop();
                        console.log("---------------stop called");
                        if (isSafari === true) {
                            this._recognition.onaudioend();
                        }
                    }, 0);
                } else {
                    transcript = results[i][0].transcript;
                    this.onresult(transcript, false);
                    document.querySelector("#speech-recognition-result").innerText = transcript;
                    console.log(transcript);
                }
            }
        }
    }

    constructor(lang="ja-JP") {
        this._recognition = new SpeechRecognition(); 
        this._recognition.lang = lang;
        this._recognition.interimResults = true; // 途中結果を返す
        // safari では、SpeechRecognition#continuous を false にすると、
        // 連続音声認識モードになるため、true にして
        // SpeechRecognition#stop() で制御する
        this._recognition.continuous = true;

        this._setup();
    }

    start() { 
        if (! this._context) {
            this._context = new AudioContext();
        }
        this._recognition.start(); 
    }

    stop() { 
        this._recognition.stop(); 
    }
}

export default SpeechRecognizer;
