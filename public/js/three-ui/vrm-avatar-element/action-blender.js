/**
 * モーション（AnimationAction）の重みを、緩急を付けて切り替える。
 *
 * three.js の fadeIn() / fadeOut() の代わり。あちらは重みを等速で変えるうえ、
 * fadeOut() は今の重みにかかわらず 1 から弱め始めるので、切り替えの途中で
 * さらに切り替えると、弱まりかけていた姿勢が一瞬強く戻ってしまう。
 *
 *   const blender = new ActionBlender();
 *   action.reset();
 *   blender.crossfadeTo(action, 0.5);   // 0.5 秒かけて action だけにする
 *   action.play();
 *   // 毎フレーム：blender.update(delta) → mixer.update(delta)
 *
 * 切り替えるときは、次の action を今の重みから 1 へ、それ以外の action を
 * すべて今の重みから 0 へ、同じ時間・同じ曲線で動かす。こうすると重みの
 * 合計は途中でも常に 1 に保たれる（切り替えの途中でさらに切り替えても同じ）。
 * 合計が 1 を割ると、three.js はその分をモデルの元の姿勢（T ポーズ）で埋める。
 *
 * 重みが 0 になった action は止める（再生の対象から外す）。
 * ここで扱う action の重みは、ほかのところで変えないこと。
 */

// 動き出しと止まり際を緩やかにする
const ease = (t) => t * t * (3 - 2 * t);

export default class ActionBlender {

    /** 扱っている action → {weight, from, to, elapsed, duration}。 */
    _states = new Map();

    /**
     * duration 秒かけて、action だけが効いている状態にする。
     *
     * action の reset() / play() は呼び出し側で行う。初めて加わる action は
     * 重み 0 から始まる（いきなり効かないよう、ここで 0 にしておく）
     *
     * @param {THREE.AnimationAction} next
     * @param {number} duration 秒。0 ならその場で切り替える
     */
    crossfadeTo(next, duration) {
        if (! this._states.has(next)) {
            this._states.set(next, {weight: 0, from: 0, to: 0, elapsed: 0, duration: 0});
            next.setEffectiveWeight(0);
        }
        for (const [action, state] of this._states) {
            this._startFade(state, (action === next) ? 1 : 0, duration);
        }
        if (duration <= 0) {
            this.update(0);
        }
    }

    /**
     * 切り替えずに、その場で action だけにする。
     * ほかの action は止め、action の重みは 1 にする
     *
     * @param {THREE.AnimationAction} action
     */
    snapTo(action) {
        this.crossfadeTo(action, 0);
    }

    /**
     * 毎フレーム、AnimationMixer を進める前に呼ぶ。
     * @param {number} delta 経過時間（秒）
     */
    update(delta) {
        for (const [action, state] of this._states) {
            if (state.elapsed < state.duration) {
                state.elapsed = Math.min(state.duration, state.elapsed + delta);
                const t = ease(state.elapsed / state.duration);
                state.weight = state.from + (state.to - state.from) * t;
            } else {
                state.weight = state.to;
            }
            action.setEffectiveWeight(state.weight);

            if (state.to === 0 && state.weight === 0) {
                action.stop();
                this._states.delete(action);
            }
        }
    }

    _startFade(state, to, duration) {
        state.from = state.weight;
        state.to = to;
        state.elapsed = 0;
        state.duration = Math.max(0, duration);
    }
}
