import * as THREE from "three";
import loadAnimation from "./animation-loader.js";


class ActionManager {

    _actionMap = {};
    _vrm = null;
    _animationMixer = null;
    _finishHandler = null;

    constructor(vrm) {
        this._vrm = vrm;

        // create AnimationMixer for VRM
        this._animationMixer = new THREE.AnimationMixer(vrm.scene);

        this._animationMixer.addEventListener("finished", e => {
            if (this._finishHandler) {
                this._finishHandler(e);
            }
        });
    }

    set onFinish(handler) {
        this._finishHandler = handler;
    }

    update(deltaTime) {
        // if animation is loaded
        if (this._animationMixer) {
	    // update the animation
	    this._animationMixer.update(deltaTime);
        }
    }

    getAction(name) {
        return this._actionMap[name];
    }

    /** 登録済みのモーション名。画面の選択肢を組み立てるのに使う。 */
    getActionNames() {
        return Object.keys(this._actionMap);
    }

    /**
     * モーションを読み込む。
     *
     * @param {string} animationUrl
     * @param {string} [name] 登録する名前。省略するとファイル名から作る。
     *                        画面に出す名前で呼びたい場合に指定する
     */
    loadAnimation(animationUrl, name) {
        return new Promise((resolve, reject) => {
            // Load animation
            loadAnimation(animationUrl, this._vrm)
                .then((clip) => {
                    // Apply the loaded animation to mixer and play
                    const action = this._animationMixer.clipAction(clip);
                    this._actionMap[name || this._getName(animationUrl)] = action;
                    resolve(action);
                })
                .catch((error) => {
                    reject(error);
                });
        });
    }

    _getName(url) {
        const begin = url.lastIndexOf("/");
        const end = url.lastIndexOf(".");
        return url.substring(begin+1, end);
    }
}

export default ActionManager;
