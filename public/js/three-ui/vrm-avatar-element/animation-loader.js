import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"
import mixamoVRMRigMap from "./mixamoRigMap.js";
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";

/**
 * Load VRM animation.
 *
 * @param {string} url A url of VRM animation data
 * @param {VRM} vrm A target VRM
 * @returns {Promise<THREE.AnimationClip>} The converted AnimationClip
 */
async function loadVRMAnimation(url, vrm) {
    const loader = new GLTFLoader();
    loader.register((parser) => {
        return new VRMAnimationLoaderPlugin(parser);
    });
    const gltfVrma = await loader.loadAsync(url);
    const vrmAnimation = gltfVrma.userData.vrmAnimations[0];

    // create animation clip
    return createVRMAnimationClip(vrmAnimation, vrm);
}

/**
 * Load Mixamo animation, convert for three-vrm use, and return it.
 *
 * @param {string} url A url of mixamo animation data
 * @param {VRM} vrm A target VRM
 * @returns {Promise<THREE.AnimationClip>} The converted AnimationClip
 */
async function loadMixamoAnimation(url, vrm) {

    const loader = new FBXLoader(); // A loader which loads FBX
    const asset = await loader.loadAsync(url);
    const clip = THREE.AnimationClip.findByName(asset.animations, 'mixamo.com'); // extract the AnimationClip

    const tracks = []; // KeyframeTracks compatible with VRM will be added here

    const restRotationInverse = new THREE.Quaternion();
    const parentRestWorldRotation = new THREE.Quaternion();
    const _quatA = new THREE.Quaternion();
    const _vec3 = new THREE.Vector3();

    // Adjust with reference to hips height.
    const motionHipsHeight = asset.getObjectByName('mixamorigHips').position.y;
    const vrmHipsY = vrm.humanoid?.getNormalizedBoneNode('hips').getWorldPosition( _vec3 ).y;
    const vrmRootY = vrm.scene.getWorldPosition( _vec3 ).y;
    const vrmHipsHeight = Math.abs( vrmHipsY - vrmRootY );
    const hipsPositionScale = vrmHipsHeight / motionHipsHeight;

    clip.tracks.forEach((track) => {
        // Convert each tracks for VRM use, and push to `tracks`
        const trackSplitted = track.name.split('.');
        const mixamoRigName = trackSplitted[0];
        const vrmBoneName = mixamoVRMRigMap[mixamoRigName];
        const vrmNodeName = vrm.humanoid?.getNormalizedBoneNode(vrmBoneName)?.name;
        const mixamoRigNode = asset.getObjectByName(mixamoRigName);

        if (vrmNodeName != null) {
            const propertyName = trackSplitted[1];

            // Store rotations of rest-pose.
            mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
            mixamoRigNode.parent.getWorldQuaternion(parentRestWorldRotation);

            if (track instanceof THREE.QuaternionKeyframeTrack) {
                // Retarget rotation of mixamoRig to NormalizedBone.
                for (let i = 0; i < track.values.length; i += 4) {

                    const flatQuaternion = track.values.slice( i, i + 4 );
                    _quatA.fromArray( flatQuaternion );

                    // 親のレスト時ワールド回転 * トラックの回転 * レスト時ワールド回転の逆
                    _quatA
                        .premultiply(parentRestWorldRotation)
                        .multiply(restRotationInverse);
                    _quatA.toArray(flatQuaternion);

                    flatQuaternion.forEach((v, index) => {
                        track.values[index + i] = v;
                    });
                }

                tracks.push(
                    new THREE.QuaternionKeyframeTrack(
                        `${vrmNodeName}.${propertyName}`,
                        track.times,
                        track.values.map((v, i) => (vrm.meta?.metaVersion === '0' && i % 2 === 0 ? - v : v)),
                    ),
                );
            } else if (track instanceof THREE.VectorKeyframeTrack) {
                const value = track.values.map(
                    (v, i) => (vrm.meta?.metaVersion === '0' && i % 3 !== 1 ? - v : v) * hipsPositionScale
                );
                tracks.push(new THREE.VectorKeyframeTrack(`${vrmNodeName}.${propertyName}`, track.times, value));
            }
        }
    });
    return new THREE.AnimationClip('vrmAnimation', clip.duration, tracks);
}


async function loadAnimation(url, vrm) {
    if (url.toLowerCase().endsWith(".vrma")) {
        return await loadVRMAnimation(url, vrm);
    }
    if (url.endsWith(".fbx")) {
        return await loadMixamoAnimation(url, vrm);
    }
    throw new Error("unknown format");
}

/**
 * くり返し再生するモーション（歩く・走るなど）の、最後から最初へのつなぎ目を
 * 滑らかにする。元のクリップは書き換えず、新しいクリップを返す。
 *
 * くり返し用のモーションは「一歩分の周期」だけを収めたものが多いが、最後の
 * コマは最初のコマの 1 コマ手前で終わっている。そのままくり返すと、最後から
 * 最初へ一瞬で跳ぶ。そこで、最初のコマの写しを 1 コマ分の間隔を空けて最後に
 * 足し、最後から最初へも補間されるようにする。
 *
 * 先頭の 2 コマが全く同じ（書き出し時の重複）なら、先に 1 つ落とす。落とさないと
 * くり返すたびに一瞬止まって見える。
 *
 * @param {THREE.AnimationClip} clip
 * @returns {THREE.AnimationClip}
 */
function closeLoop(clip) {
    // 基準にするのは、いちばんコマの多いトラックの時刻
    const reference = clip.tracks.reduce(
        (longest, track) => (track.times.length > (longest?.times.length ?? 0)) ? track : longest,
        null);
    if (! reference || reference.times.length < 3) {
        return clip;
    }
    const times = reference.times;

    // 1 コマの間隔。途中の間隔の中央値をとる（端の乱れに引きずられないように）
    const intervals = [];
    for (let i = 1; i < times.length; i++) {
        intervals.push(times[i] - times[i - 1]);
    }
    intervals.sort((a, b) => a - b);
    const frame = intervals[Math.floor(intervals.length / 2)];

    // 動いているトラック（2 コマ以上）が、どれも基準と同じ時刻で並んでいるか。
    // 揃っていないものは、落とす・足すを正しく揃えられないので手を付けない
    const moving = clip.tracks.filter((track) => track.times.length >= 2);
    const aligned = moving.every((track) => track.times.length === times.length
                                 && track.times[0] === times[0] && track.times[1] === times[1]);
    if (! aligned) {
        console.warn(`<vrm-avatar>: "${clip.name}" は時刻の揃わないトラックがあるため、`
                     + "つなぎ目を整えずにくり返します");
        return clip;
    }

    const EPSILON = 1e-5;
    const duplicatedHead = moving.every((track) => {
        const size = track.getValueSize();
        for (let k = 0; k < size; k++) {
            if (Math.abs(track.values[k] - track.values[size + k]) > EPSILON) {
                return false;
            }
        }
        return true;
    });

    const tracks = clip.tracks.map((track) => {
        if (track.times.length < 2) {
            return track; // 動かないトラック
        }
        const size = track.getValueSize();
        let trackTimes = Array.from(track.times);
        let values = Array.from(track.values);
        if (duplicatedHead) {
            const start = trackTimes[1];
            trackTimes = trackTimes.slice(1).map((t) => t - start);
            values = values.slice(size);
        }
        trackTimes.push(trackTimes[trackTimes.length - 1] + frame);
        values.push(...values.slice(0, size));
        return new track.constructor(track.name, trackTimes, values);
    });

    return new THREE.AnimationClip(clip.name, -1, tracks); // -1 で長さを測り直す
}

export { closeLoop };
export default loadAnimation;
