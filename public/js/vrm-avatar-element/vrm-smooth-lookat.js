import * as THREE from "three";
import { VRMLookAt } from "@pixiv/three-vrm";

// extended lookat
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
    }

    update(delta) {
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
