import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

const VrmLoader = (() => {

    const loader = new GLTFLoader();
    loader.crossOrigin = 'anonymous';
    loader.register((parser) => {
        return new VRMLoaderPlugin(parser);
    });

    const methods = {
        /**
         * @param {string} url VRM ファイルの URL
         * @param {(value: number) => void} [onProgress] 進捗(0-100)の通知先。
         *        複数のモデルを同時に読み込んでも混ざらないよう、呼び出しごとに指定する。
         */
        load: (url, onProgress) => {
            let vrm = undefined;
            return new Promise((resolve, reject) => {
                loader.load(url, (gltf) => {
                    vrm = gltf.userData.vrm;

                    // if (this._currentVrm) {
                    //     scene.remove(this._currentVrm.scene);
                    //     VRMUtils.deepDispose(this._currentVrm.scene);
                    // }
                    
                    // calling these functions greatly improves the performance
                    VRMUtils.removeUnnecessaryVertices(gltf.scene);
		    VRMUtils.combineSkeletons(gltf.scene);
		    VRMUtils.combineMorphs(vrm);

                    // Disable frustum culling
                    vrm.scene.traverse((obj) => {
                        obj.frustumCulled = false;
                    });

                    // // replace the lookAt to our extended one
                    // const smoothLookAt = new VRMSmoothLookAt(vrm.humanoid, vrm.lookAt.applier);
                    // smoothLookAt.copy(vrm.lookAt);
                    // vrm.lookAt = smoothLookAt;
                    // vrm.lookAt.target = camera;

                    /*
                    const smoothLookAt = new VRMSmoothLookAt(vrm.humanoid, vrm.lookAt.applier);
                    smoothLookAt.copy(vrm.lookAt);
                    vrm.lookAt = smoothLookAt;

                    scene.add(vrm.scene);

                    vrm.lookAt.target = camera;
                    */
                    //console.log(vrm);
                    resolve(vrm);
                },
                (progress) => {
                    if (onProgress) {
                        const value = 100.0 * (progress.loaded/progress.total);
                        onProgress(Math.trunc(value));
                    }
                },
                (error) => {
                    reject(error);
                });
            });
        }
    };
    return methods;

})();

export default VrmLoader;
