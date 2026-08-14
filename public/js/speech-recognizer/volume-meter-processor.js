// copyright (c) 2022 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/* global currentTime */

const SMOOTHING_FACTOR = 0.8;
const FRAME_PER_SECOND = 30;//60;
const FRAME_INTERVAL = 1 / FRAME_PER_SECOND;

/**
 *  Measure microphone volume.
 *
 * @class VolumeMeter
 * @extends AudioWorkletProcessor
 */
class VolumeMeter extends AudioWorkletProcessor {

    _lastUpdate = null;
    _volume = 0;

    constructor() {
        super();
        this._lastUpdate = currentTime;
        this._volume = 0;
    }

    calculateRMS(inputChannelData) {
        // Calculate the squared-sum.
        let sum = 0;

        //console.log(inputChannelData.length);
        for (let i = 0; i < inputChannelData.length; i++) {
            //sum += inputChannelData[i] * inputChannelData[i];
            //console.log(inputChannelData[i]);
            let value = inputChannelData[i]/*[-1,1]*/;
            sum += value * value;
        }
        // Calculate the RMS level and update the volume.
        let rms = Math.sqrt(sum / inputChannelData.length);
        this._volume = Math.max(rms, this._volume * SMOOTHING_FACTOR);
    }

    process(inputs, outputs/*,parameters*/) {
        // This example only handles mono channel.
        const inputChannelData = inputs[0][0];
        //const gain = parameters["customGain"][0];

        // Post a message to the node every 16ms.
        if (currentTime - this._lastUpdate > FRAME_INTERVAL) {
            this.calculateRMS(inputChannelData);
            this.port.postMessage(this._volume);
            this._lastUpdate = currentTime;
        }

        return true;
    }

    /*
    // define the customGain parameter used in process method
    static get parameterDescriptors() {
        return [
            {
                name: "customGain",
                defaultValue: 1,
                minValue: 0,
                maxValue: 1,
                automationRate: "a-rate",
            },
        ];
    }
    */
}

registerProcessor("volume-meter", VolumeMeter);
