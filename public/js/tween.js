/**
 * 値を時間をかけて変化させる（トゥイーン）ための小さなユーティリティ。
 *
 * Unity の DoTween における `DOTween.To(getter, setter, endValue, duration)` に相当する。
 * setTimeout ではなく描画ループから update() を呼んで進めるため、フレームと同期し、
 * タブが非表示で描画が止まっている間は一緒に止まる。
 *
 *   await runner.tween({
 *       from: () => current,     // 開始値。関数なら開始時に一度だけ評価する
 *       to: 1.0,
 *       duration: 0.3,           // 秒
 *       onUpdate: (v) => setValue(v)
 *   });
 */

// 進捗 t (0-1) を変化量 (0-1) に変換する
const EASINGS = {
    linear:    (t) => t,
    easeIn:    (t) => t * t,
    easeOut:   (t) => t * (2 - t),
    easeInOut: (t) => (t < 0.5) ? 2 * t * t : -1 + (4 - 2 * t) * t
};

const DEFAULT_EASING = "easeInOut";

class Tween {

    constructor({from, to, duration, onUpdate, easing, key}) {
        this._from = (typeof from === "function") ? from() : from;
        this._to = to;
        this._duration = duration;
        this._onUpdate = onUpdate;
        this._easing = (typeof easing === "function")
            ? easing
            : (EASINGS[easing] || EASINGS[DEFAULT_EASING]);
        this.key = key ?? null;

        this._elapsed = 0;
        this._settle = null;
        this.promise = new Promise((resolve) => {
            this._settle = resolve;
        });
    }

    /**
     * 時間を進める。
     * @param {number} delta 経過秒
     * @returns {boolean} 変化し切ったら true
     */
    update(delta) {
        this._elapsed += delta;

        // duration が 0 以下なら即座に到達させる
        const progress = (this._duration > 0)
              ? Math.min(this._elapsed / this._duration, 1)
              : 1;

        this._onUpdate(this._from + (this._to - this._from) * this._easing(progress));
        return progress >= 1;
    }

    /** 変化し切った状態にしてから終了する。 */
    finish() {
        this._onUpdate(this._to);
        this.settle();
    }

    /**
     * 待っている呼び出し元を解放する。
     * 中断された場合も必ず呼ぶこと（呼ばないと await が永久に返らない）。
     */
    settle() {
        if (! this._settle) {
            return;
        }
        const settle = this._settle;
        this._settle = null;
        settle();
    }
}

export default class TweenRunner {

    _tweens = new Set();

    /**
     * トゥイーンを開始する。
     *
     * @param {object} options
     * @param {number|(() => number)} options.from 開始値
     * @param {number} options.to 目標値
     * @param {number} options.duration 所要時間（秒）
     * @param {(value: number) => void} options.onUpdate 値の適用先
     * @param {string|((t: number) => number)} [options.easing] 既定は "easeInOut"
     * @param {string} [options.key] 同じ key のトゥイーンが動いていれば中断して置き換える
     * @returns {Promise<void>} 変化し切った時点で解決する。中断された場合も解決する
     */
    tween(options) {
        if (options.key) {
            this.cancel(options.key);
        }
        const tween = new Tween(options);
        this._tweens.add(tween);
        return tween.promise;
    }

    /** 描画ループから呼ぶ。 */
    update(delta) {
        if (this._tweens.size === 0) {
            return;
        }
        // 反復中に onUpdate から tween() が呼ばれても壊れないよう控えを取る
        for (const tween of [...this._tweens]) {
            if (tween.update(delta)) {
                this._tweens.delete(tween);
                tween.settle();
            }
        }
    }

    /**
     * 指定した key のトゥイーンを中断する。値はその時点のまま。
     * @returns {boolean} 中断したものがあれば true
     */
    cancel(key) {
        let cancelled = false;
        for (const tween of this._tweens) {
            if (tween.key === key) {
                this._tweens.delete(tween);
                tween.settle();
                cancelled = true;
            }
        }
        return cancelled;
    }

    /** すべて中断する。破棄時に呼ぶこと。 */
    cancelAll() {
        for (const tween of this._tweens) {
            tween.settle();
        }
        this._tweens.clear();
    }

    get count() {
        return this._tweens.size;
    }
}

export {EASINGS};
