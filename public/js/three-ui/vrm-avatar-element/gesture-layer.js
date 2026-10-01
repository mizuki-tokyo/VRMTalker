import * as THREE from "three";

/**
 * ジェスチャー：モーションの上から、一部の骨（腕や手）だけを上書きする層。
 *
 * モーション（AnimationMixer）が骨を動かした後、VRM へ反映する前に呼ぶ。
 * 待機モーションやポーズ、歩いている最中でも、その骨だけを決めた向きへ寄せる。
 *
 *   const layer = new GestureLayer(vrm);
 *   await layer.play({leftUpperArm: q1, leftLowerArm: q2}, 3);   // 3 秒して戻る
 *   // 毎フレーム：mixer.update() → layer.update(delta) → vrm.update()
 *
 * 動き方
 *   寄せる   fadeTime 秒かけて、今の姿勢から目標の向きへ
 *   保つ     始めてから seconds 秒たつまで
 *   戻す     fadeTime 秒かけて、モーションの動きへ
 *
 * 途中で別のジェスチャーを始めると、今の見た目の位置からそのまま移る（飛ばない）。
 *
 * 骨は毎フレーム、モーション（と揺れ）を反映した直後の値になっている前提で、
 * それを「モーションの向き」として使う（前のフレームで上書きした分は
 * VrmHumanoid#update() が取り消している）。
 */

// 寄せる・戻すの時間（秒）。TalkingHead の既定と同じ
const DEFAULT_FADE_TIME = 1.0;

// 動き出しと止まり際を緩やかにする
const ease = (t) => t * t * (3 - 2 * t);

const PHASE = Object.freeze({
    idle: "idle",
    in: "in",      // 目標へ寄せている
    hold: "hold",  // 保っている
    out: "out"     // モーションへ戻している
});

export default class GestureLayer {

    _vrm = null;

    /**
     * 上書きしている骨。VRM の骨の名前 → 状態。
     *
     *   node     正規化された骨のノード
     *   from     移り始めの向き。null ならモーションの向き
     *   to       移り先の向き。null ならモーションの向き（戻している骨）
     *   applied  前のフレームで書いた向き（途中で切り替えるときの移り始めになる）
     */
    _bones = new Map();

    _phase = PHASE.idle;
    _progress = 0;       // 寄せる・戻すの進み具合（0-1）
    _fadeTime = DEFAULT_FADE_TIME;
    _elapsed = 0;        // 始めてからの時間（秒）
    _seconds = Infinity; // この時間がたったら戻し始める

    // 終わるのを待っている Promise の resolve
    _resolve = null;

    constructor(vrm) {
        this._vrm = vrm;
    }

    /** ジェスチャーの最中か（戻している途中も含む）。 */
    get isActive() {
        return this._phase !== PHASE.idle;
    }

    /**
     * ジェスチャーを始める。前のジェスチャーは置き換える。
     *
     * @param {Object<string, THREE.Quaternion>} rotations VRM の骨の名前 → 向き
     *        （正規化された骨のローカルの回転）
     * @param {number} [seconds] 始めてから戻し始めるまでの秒数。Infinity なら stop() まで
     * @param {number} [fadeTime] 寄せる・戻すのにかける秒数
     * @returns {Promise<void>} 戻し終えた時点で解決する。途中で置き換えられた・
     *          打ち切られたときも解決する（待っている側を取り残さない）
     */
    play(rotations, seconds = 3, fadeTime = DEFAULT_FADE_TIME) {
        this._settle();

        // 今の見た目の位置から移る。今回使わない骨は、モーションの向きへ戻す
        for (const bone of this._bones.values()) {
            bone.from = bone.applied.clone();
            bone.to = null;
        }
        for (const [name, rotation] of Object.entries(rotations)) {
            const node = this._vrm.humanoid.getNormalizedBoneNode(name);
            if (! node) {
                continue; // このモデルに無い骨
            }
            let bone = this._bones.get(name);
            if (! bone) {
                bone = {node, from: null, to: null, applied: node.quaternion.clone()};
                this._bones.set(name, bone);
            }
            bone.to = rotation.clone();
        }

        this._phase = PHASE.in;
        this._progress = 0;
        this._fadeTime = Math.max(0.01, fadeTime);
        this._elapsed = 0;
        this._seconds = Math.max(0, Number(seconds));

        return new Promise((resolve) => {
            this._resolve = resolve;
        });
    }

    /** 戻し始める。待っている呼び出し元は、戻し終えた時点で解決する。 */
    stop() {
        if (this._phase === PHASE.idle || this._phase === PHASE.out) {
            return;
        }
        for (const bone of this._bones.values()) {
            bone.from = bone.applied.clone();
            bone.to = null;
        }
        this._phase = PHASE.out;
        this._progress = 0;
    }

    /**
     * すぐに打ち切る。次のフレームからはモーションの向きのまま。
     * モデルを捨てるときに使う（戻す間を待たない）。
     */
    clear() {
        this._bones.clear();
        this._phase = PHASE.idle;
        this._settle();
    }

    /**
     * 毎フレーム、モーションを反映した後に呼ぶ。
     * @param {number} delta 経過時間（秒）
     */
    update(delta) {
        if (this._phase === PHASE.idle) {
            return;
        }

        this._elapsed += delta;
        if (this._phase === PHASE.in || this._phase === PHASE.out) {
            this._progress = Math.min(1, this._progress + delta / this._fadeTime);
        }

        const t = ease(this._progress);
        for (const bone of this._bones.values()) {
            const base = bone.node.quaternion.clone(); // このフレームのモーションの向き
            const from = bone.from ?? base;
            const to = bone.to ?? base;
            bone.node.quaternion.slerpQuaternions(from, to, t);
            bone.applied.copy(bone.node.quaternion);
        }

        if (this._progress >= 1) {
            this._finishTransition();
        }
        if (this._phase === PHASE.hold && this._elapsed >= this._seconds) {
            this.stop();
        }
    }

    _finishTransition() {
        if (this._phase === PHASE.in) {
            // 戻し終えた骨は手放す。残りは目標の向きで保つ
            for (const [name, bone] of this._bones) {
                if (bone.to === null) {
                    this._bones.delete(name);
                } else {
                    bone.from = bone.to;
                }
            }
            this._phase = PHASE.hold;
        } else if (this._phase === PHASE.out) {
            this._bones.clear();
            this._phase = PHASE.idle;
            this._settle();
        }
    }

    _settle() {
        if (! this._resolve) {
            return;
        }
        const resolve = this._resolve;
        this._resolve = null;
        resolve();
    }
}
