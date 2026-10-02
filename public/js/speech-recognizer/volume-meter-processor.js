// copyright (c) 2022 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/*
  マイクの音量を測る AudioWorklet（音声処理のスレッドで動く）。
  volume-meter.js が読み込んで使う。

  届いた音の大きさ（RMS）を、前の値を少しずつ減らしながら保ち（すぐ 0 に
  落とさず、針がなめらかに戻るように）、一定の間隔でメインスレッドへ送る。
*/

/* global currentTime */

// 減衰の速さ。ScriptProcessorNode で 512 サンプルごとに 0.95 倍していたのと
// 同じになるよう、届く長さ（ふつう 128 サンプル）に合わせて換算する
const DECAY_PER_512_SAMPLES = 0.95;

// メインスレッドへ送る回数（1 秒あたり）
const POSTS_PER_SECOND = 60;

class VolumeMeterProcessor extends AudioWorkletProcessor {

    _volume = 0;
    _lastPost = 0;

    constructor() {
        super();
        // 測り始めるときに呼ばれる。前の回の値を持ち越さない
        this.port.onmessage = () => {
            this._volume = 0;
        };
    }

    process(inputs) {
        // モノラルとして扱う（最初のチャンネルだけを見る）。
        // 入力がつながっていないとき（止めている間）は空で届くので、何も送らない
        const channel = inputs[0]?.[0];
        if (! channel || channel.length === 0) {
            return true;
        }

        let sum = 0;
        for (let i = 0; i < channel.length; i++) {
            sum += channel[i] * channel[i];
        }
        const rms = Math.sqrt(sum / channel.length);
        const decay = DECAY_PER_512_SAMPLES ** (channel.length / 512);
        this._volume = Math.max(rms, this._volume * decay);

        if (currentTime - this._lastPost >= 1 / POSTS_PER_SECOND) {
            this.port.postMessage(this._volume);
            this._lastPost = currentTime;
        }

        // 止めない（同じノードを使い回す。つなぎ直せばまた測る）
        return true;
    }
}

registerProcessor("volume-meter", VolumeMeterProcessor);
