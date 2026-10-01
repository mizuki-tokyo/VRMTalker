import * as THREE from "three";

/**
 * 止まったポーズに、呼吸と小さな揺れを足す。
 *
 * ポーズは 1 コマだけのモーションなので、そのままだと人形のように固まって
 * 見える。待機モーションには元から揺れがあるので、ポーズの間だけ効かせる。
 *
 *   const sway = new PoseSway(vrm);
 *   // 毎フレーム：mixer.update() → sway.update(delta, ポーズ中か) → vrm.update()
 *
 * 足すのは次の 3 つ。どれも数度以内の小さな回転で、骨の今の向きに掛け足す。
 *
 *   呼吸      約 4 秒周期。胸がわずかに反り、肩が少し上がる。頭は首で打ち消す
 *   体の揺れ  背骨と胸が、ゆっくり不規則に揺れる
 *   頭の揺れ  頭が、ゆっくり不規則に少し向きを変える
 *
 * 腰は動かさない。腰を回すと脚ごと動いて、足が床を滑って見えるため。
 * 腕と手はジェスチャーが後から上書きするので、ジェスチャーの間はそちらが勝つ。
 *
 * 骨は毎フレーム、モーションを反映した直後の値になっている前提で、そこへ
 * 掛け足す（前のフレームで足した分は VrmHumanoid#update() が取り消している）。
 */

// ポーズに入る・出るときに、揺れを強める・弱める時間（秒）
const FADE_TIME = 1.0;

// 呼吸の周期（秒）。大人が落ち着いているときの 1 分 15 回ほど
const BREATH_PERIOD = 4.0;

const deg = THREE.MathUtils.degToRad;

/**
 * ゆっくり不規則に揺れる値（-1〜1 程度）を作る。
 * 周期の揃わない正弦波を重ねているので、同じ動きの繰り返しに見えにくい。
 * 位相はモデルごとにばらつかせる
 */
const createWander = (frequencies) => {
    const waves = frequencies.map((frequency, i) => ({
        frequency,
        amplitude: 1 / (i + 1),
        phase: Math.random() * Math.PI * 2
    }));
    const total = waves.reduce((sum, wave) => sum + wave.amplitude, 0);
    return (time) => waves.reduce(
        (sum, wave) => sum + wave.amplitude * Math.sin(2 * Math.PI * wave.frequency * time + wave.phase),
        0) / total;
};

export default class PoseSway {

    _vrm = null;
    _time = 0;
    _weight = 0;

    /** 動かす骨。VRM の骨の名前 → 正規化された骨のノード。 */
    _bones = new Map();

    // 揺れのもと。軸ごとに別の揺れにして、動きが揃わないようにする
    _body = {
        pitch: createWander([0.07, 0.17]),
        yaw: createWander([0.05, 0.13]),
        roll: createWander([0.06, 0.19])
    };
    _head = {
        pitch: createWander([0.09, 0.23]),
        yaw: createWander([0.04, 0.11, 0.29]),
        roll: createWander([0.08, 0.21])
    };

    constructor(vrm) {
        this._vrm = vrm;
        // VRM 0.x はモデルが後ろ向きに作られていて、前後・左右の回転の向きが逆になる
        this._flip = (vrm.meta?.metaVersion === "0") ? -1 : 1;
        for (const name of ["spine", "chest", "upperChest", "neck", "head",
                            "leftShoulder", "rightShoulder"]) {
            const node = vrm.humanoid.getNormalizedBoneNode(name);
            if (node) {
                this._bones.set(name, node);
            }
        }
    }

    /**
     * 毎フレーム、モーションを反映した後に呼ぶ。
     *
     * @param {number} delta 経過時間（秒）
     * @param {boolean} active ポーズをとっている最中か。外れると弱めて消す
     */
    update(delta, active) {
        this._time += delta;
        const target = active ? 1 : 0;
        const step = delta / FADE_TIME;
        this._weight = (this._weight < target)
            ? Math.min(target, this._weight + step)
            : Math.max(target, this._weight - step);

        if (this._weight === 0) {
            return; // 何も足さない
        }

        const w = this._weight * this._weight * (3 - 2 * this._weight);
        const t = this._time;

        // 呼吸（0 = 吐き切った、1 = 吸い切った）。吸う・吐くを滑らかにつなぐ
        const breath = 0.5 - 0.5 * Math.cos(2 * Math.PI * t / BREATH_PERIOD);

        const body = {
            pitch: this._body.pitch(t) * 0.6,
            yaw: this._body.yaw(t) * 1.0,
            roll: this._body.roll(t) * 0.8
        };
        const head = {
            pitch: this._head.pitch(t) * 2.0,
            yaw: this._head.yaw(t) * 3.0,
            roll: this._head.roll(t) * 1.5
        };

        // 骨ごとの回転（度）。[前後に倒す, 左右に回す, 左右に傾ける]
        // 前後はマイナスで反る。胸が反るぶん、首と頭を戻して顔の向きを保つ
        this._apply("spine", w, [-0.4 * breath + body.pitch * 0.5, body.yaw * 0.4, body.roll * 0.5]);
        this._apply("chest", w, [-0.8 * breath + body.pitch * 0.5, body.yaw * 0.3, body.roll * 0.3]);
        this._apply("upperChest", w, [-0.8 * breath, body.yaw * 0.3, body.roll * 0.2]);
        this._apply("neck", w, [1.2 * breath + head.pitch * 0.4, head.yaw * 0.4, head.roll * 0.4]);
        this._apply("head", w, [0.6 * breath + head.pitch * 0.6, head.yaw * 0.6, head.roll * 0.6]);

        // 息を吸うと肩が上がる。左肩は +Z、右肩は −Z の回転で上がる
        this._apply("leftShoulder", w, [0, 0, 1.5 * breath]);
        this._apply("rightShoulder", w, [0, 0, -1.5 * breath]);
    }

    /**
     * 骨の今の向きに、小さな回転を掛け足す。
     * @param {string} name VRM の骨の名前
     * @param {number} weight 0-1
     * @param {number[]} degrees [x, y, z]（度）
     */
    _apply(name, weight, [x, y, z]) {
        const node = this._bones.get(name);
        if (! node) {
            return;
        }
        const flip = this._flip;
        const sway = new THREE.Quaternion().setFromEuler(new THREE.Euler(
            deg(x * weight) * flip, deg(y * weight), deg(z * weight) * flip, "XYZ"));
        node.quaternion.multiply(sway);
    }
}
