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

                    // calling these functions greatly improves the performance
                    VRMUtils.removeUnnecessaryVertices(gltf.scene);
		    VRMUtils.combineSkeletons(gltf.scene);
		    VRMUtils.combineMorphs(vrm);

                    // Disable frustum culling
                    vrm.scene.traverse((obj) => {
                        obj.frustumCulled = false;
                    });

                    // 視線をなめらかに動かす版への差し替えは、VrmHumanoid が行う
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
