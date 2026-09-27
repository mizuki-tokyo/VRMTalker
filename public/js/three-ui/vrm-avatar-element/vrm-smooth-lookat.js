import * as THREE from "three";
import { VRMLookAt } from "@pixiv/three-vrm";

/**
 * 視線を、急に飛ばさず滑らかに動かす VRMLookAt。
 *
 * 動き方は 2 つ。
 *
 *   追従   follow(target) で、対象（ふつうはカメラ）を目で追う
 *   手動   setGaze(yaw, pitch) / gazeAt(位置) で、決めた向きに留まる
 *
 * どちらも指数減衰で寄せるので、フレーム落ちしても速さが変わらない。
 * 寄せる速さは smoothFactor（大きいほど速い）。
 *
 * 本家の VRMLookAt は、角度を入れた次のフレームで**そのまま**適用する。
 * 手動に切り替えたあと追従へ戻すと、表示用の角度（_yawDamped）が置き去りに
 * なって視線が飛ぶため、手動のときも同じ値を動かしている。
 *
 * 角度の向きは three-vrm の決まりに従う（実測で確かめた）。
 *
 *   yaw   ＋で画面の右（アバターから見て左）、−で画面の左
 *   pitch ＋で下、−で上
 */
class VRMSmoothLookAt extends VRMLookAt {

    static _v3A = new THREE.Vector3();

    constructor(humanoid, applier) {
        super(humanoid, applier);

        // a factor used for animation
        this.smoothFactor = 10.0;

        // maximum angles the lookAt tracks
        this.yawLimit = 45.0;
        this.pitchLimit = 45.0;

        // Actual angles applied, animated
        this._yawDamped = 0.0;
        this._pitchDamped = 0.0;

        // 手動で向けているときの目標角。null なら手動ではない
        this._manualYaw = null;
        this._manualPitch = null;
    }

    /** 手動で向けている最中か。 */
    get isManual() {
        return this._manualYaw !== null;
    }

    /**
     * 向きを決めて、そこへ寄せる。追従はやめる。
     *
     * @param {number} yaw   ＋で画面の右、−で左（度）
     * @param {number} pitch ＋で下、−で上（度）
     */
    setGaze(yaw, pitch) {
        this._manualYaw = yaw;
        this._manualPitch = pitch;
        this.autoUpdate = false;
        this.target = null;
    }

    /**
     * その場所を見る向きを求めて、そこで止める。
     *
     * 追従（follow）と違い、一度向けたら相手が動いても付いていかない。
     *
     * @param {THREE.Vector3} worldPosition
     */
    gazeAt(worldPosition) {
        // lookAt() が _yaw / _pitch を計算してくれる。それを目標として borrow する
        this.lookAt(worldPosition);
        this.setGaze(this._yaw, this._pitch);
    }

    /** 対象を目で追う（はじめの状態へ戻すのもこれ）。 */
    follow(target) {
        this._manualYaw = null;
        this._manualPitch = null;
        this.target = target;
        this.autoUpdate = true;
    }

    update(delta) {
        if (this.isManual) {
            const k = 1.0 - Math.exp(- this.smoothFactor * delta);
            this._yawDamped += (this._manualYaw - this._yawDamped) * k;
            this._pitchDamped += (this._manualPitch - this._pitchDamped) * k;

            // 追従へ戻したときに飛ばないよう、生の角度も合わせておく
            this._yaw = this._yawDamped;
            this._pitch = this._pitchDamped;

            this.applier.applyYawPitch(this._yawDamped, this._pitchDamped);
            this._needsUpdate = false;
            return;
        }

        if (this.target && this.autoUpdate) {
            // this updates `_yaw` and `_pitch`
            this.lookAt(this.target.getWorldPosition(VRMSmoothLookAt._v3A));
            //this.lookAt(camera.position); // LookAt camera

            // limit angles
            if (this.yawLimit < Math.abs(this._yaw) || this.pitchLimit < Math.abs(this._pitch)) {
                this._yaw = 0.0;
                this._pitch = 0.0;
            }

            // animate angles
            const k = 1.0 - Math.exp(- this.smoothFactor * delta);

            this._yawDamped += (this._yaw - this._yawDamped) * k;
            this._pitchDamped += (this._pitch - this._pitchDamped) * k;

            // apply the animated angles
            this.applier.applyYawPitch(this._yawDamped, this._pitchDamped);

            // there is no need to update twice
            this._needsUpdate = false;
        }

        // usual update procedure
        if (this._needsUpdate) {
            this._needsUpdate = false;
            this.applier.applyYawPitch( this._yaw, this._pitch );
        }
    }
}

export default VRMSmoothLookAt;
