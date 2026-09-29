import * as THREE from "three";
import mixamoVRMRigMap from "./mixamoRigMap.js";

/**
 * TalkingHead のポーズ・ジェスチャー（talkinghead-templates.js）を、
 * VRM の骨の回転に変換する。
 *
 * TalkingHead の値は、Mixamo 互換の骨格で「親の骨から見た回転」をそのまま
 * 差し替えるものなので、骨格ごとの基準の向きを知らないと VRM へ移せない。
 * 既存の FBX の変換（animation-loader.js）と同じく、
 *
 *   VRM の骨の回転 = 親の基準の向き × 値の回転 × 自分の基準の向きの逆
 *
 * で移す。VRM の正規化された骨は T ポーズが基準なので、ここでの基準の向きも
 * T ポーズのものを使う（TPOSE_REFERENCE）。
 */

/**
 * 腕から先の骨の、骨を軸にしたねじれの補正（度）。左側の値で、右側は符号を反転して使う。
 *
 * TalkingHead の値は Ready Player Me の骨格に合わせて作られていて、その骨格では
 * 前腕・手・指の骨が、骨を軸に少しねじれた向きで組まれている。値はこのねじれを
 * 前提にしているので、規則どおりの向き（ねじれ 0）のままだと手の向きがずれる。
 * TalkingHead での表示（OK サイン・人差し指・手を挙げるなど）と見比べて合わせた値。
 */
const TWIST_DEGREES = {
    ForeArm: -15,
    Hand: -30,
    Thumb: -20,
    Index: -30,
    Middle: -25,
    Ring: -15,
    Pinky: -10
};

/**
 * Mixamo 互換の骨格を T ポーズにしたときの、各骨の向き（ワールド、クォータニオン）。
 *
 * 特定のモデルの数値は使わず、次の規則で決める（顔は +Z、左手は +X の方向）。
 *   - 骨の Y 軸は骨の伸びる方向（Mixamo 互換の骨格の約束）
 *   - 体と頭は、ワールドの軸にそろえる
 *   - 腕と指は真横で、手のひらは下。X 軸は後ろ（右側は前）
 *   - 親指は斜め前（真横から約 40 度）で、X 軸は下（右側は上）
 *   - 脚は真下、足は斜め下前、つま先は前。X 軸は右
 * そのうえで、腕から先には twist（TWIST_DEGREES）のねじれを加える。
 * _root は Hips の親（Armature）の向き。
 *
 * @param {object} twist 骨の種類 → ねじれ（度）。TWIST_DEGREES と同じ形
 * @returns {Object<string, number[]>} 骨の名前 → クォータニオン（配列）
 */
export function createTPoseReference(twist) {
    const frame = (y, x, twistDegrees = 0) => {
        const Y = new THREE.Vector3(...y).normalize();
        const X = new THREE.Vector3(...x).normalize();
        const Z = new THREE.Vector3().crossVectors(X, Y);
        const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
        // 骨の Y 軸（骨の伸びる方向）を軸にねじる
        q.multiply(new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(twistDegrees)));
        return q.toArray();
    };

    const reference = {_root: [0, 0, 0, 1]};
    for (const bone of ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"]) {
        reference[bone] = [0, 0, 0, 1];
    }
    for (const [side, s] of [["Left", 1], ["Right", -1]]) {
        reference[`${side}Shoulder`] = frame([s, 0, 0], [0, 0, -s]);
        reference[`${side}Arm`] = frame([s, 0, 0], [0, 0, -s]);
        reference[`${side}ForeArm`] = frame([s, 0, 0], [0, 0, -s], s * twist.ForeArm);
        reference[`${side}Hand`] = frame([s, 0, 0], [0, 0, -s], s * twist.Hand);
        for (const finger of ["Index", "Middle", "Ring", "Pinky"]) {
            for (const i of [1, 2, 3]) {
                reference[`${side}Hand${finger}${i}`] =
                    frame([s, 0, 0], [0, 0, -s], s * twist[finger]);
            }
        }
        for (const i of [1, 2, 3]) {
            reference[`${side}HandThumb${i}`] =
                frame([s * 0.76, 0, 0.65], [0, -s, 0], s * twist.Thumb);
        }
        reference[`${side}UpLeg`] = frame([0, -1, 0], [-1, 0, 0]);
        reference[`${side}Leg`] = frame([0, -1, 0], [-1, 0, 0]);
        reference[`${side}Foot`] = frame([0, -0.6, 0.8], [-1, 0, 0]);
        reference[`${side}ToeBase`] = frame([0, 0, 1], [-1, 0, 0]);
    }
    return reference;
}

const TPOSE_REFERENCE = createTPoseReference(TWIST_DEGREES);

/** Mixamo 互換の骨格での親子関係。基準の向きの「親」を引くのに使う。 */
const MIXAMO_PARENTS = (() => {
    const parents = {
        Hips: "_root", Spine: "Hips", Spine1: "Spine", Spine2: "Spine1",
        Neck: "Spine2", Head: "Neck"
    };
    for (const side of ["Left", "Right"]) {
        Object.assign(parents, {
            [`${side}Shoulder`]: "Spine2",
            [`${side}Arm`]: `${side}Shoulder`,
            [`${side}ForeArm`]: `${side}Arm`,
            [`${side}Hand`]: `${side}ForeArm`,
            [`${side}UpLeg`]: "Hips",
            [`${side}Leg`]: `${side}UpLeg`,
            [`${side}Foot`]: `${side}Leg`,
            [`${side}ToeBase`]: `${side}Foot`
        });
        for (const finger of ["Thumb", "Index", "Middle", "Ring", "Pinky"]) {
            parents[`${side}Hand${finger}1`] = `${side}Hand`;
            parents[`${side}Hand${finger}2`] = `${side}Hand${finger}1`;
            parents[`${side}Hand${finger}3`] = `${side}Hand${finger}2`;
        }
    }
    return parents;
})();

/** TalkingHead の Hips の高さの基準（retargeter.mjs の HIPS_HEIGHT_M と同じ）。 */
const TALKINGHEAD_HIPS_HEIGHT = 1.037;

/**
 * [最小, 最大, 偏り, 標本数] の範囲から、ばらつかせた値を 1 つ選ぶ。
 * TalkingHead の gaussianRandom() と同じ計算。
 */
const gaussianRandom = (start, end, skew = 1, samples = 5) => {
    let r = 0;
    for (let i = 0; i < samples; i++) {
        r += Math.random();
    }
    return start + Math.pow(r / samples, skew) * (end - start);
};

const pick = (value) => Array.isArray(value) ? gaussianRandom(...value) : value;

/**
 * TalkingHead の書き方（rotation はオイラー角、範囲はばらつかせる）を、
 * 骨の名前 → クォータニオン / 位置 に直す。値はまだ Mixamo の骨格のもの。
 *
 * @param {object} props 例: {"LeftArm.rotation": {x, y, z}, "Hips.position": {x, y, z}}
 * @returns {{rotations: Object<string, THREE.Quaternion>, hipsPosition: THREE.Vector3|null}}
 */
export function readTemplate(props) {
    const rotations = {};
    let hipsPosition = null;
    for (const [key, value] of Object.entries(props)) {
        const [bone, property] = key.split(".");
        const x = pick(value.x), y = pick(value.y), z = pick(value.z);
        if (property === "rotation") {
            rotations[bone] = new THREE.Quaternion()
                .setFromEuler(new THREE.Euler(x, y, z, "XYZ")).normalize();
        } else if (property === "quaternion") {
            rotations[bone] = new THREE.Quaternion(x, y, z, value.w).normalize();
        } else if (property === "position" && bone === "Hips") {
            hipsPosition = new THREE.Vector3(x, y, z);
        }
    }
    return {rotations, hipsPosition};
}

/**
 * 左右を入れ替える（体重をかける足や、ジェスチャーの手を反対にする）。
 * TalkingHead の mirrorPose() と同じく、Mixamo の骨格の上で入れ替える。
 *
 * @param {Object<string, THREE.Quaternion>} rotations readTemplate() の rotations
 * @returns {Object<string, THREE.Quaternion>}
 */
export function mirrorRotations(rotations) {
    const mirrored = {};
    for (const [bone, q] of Object.entries(rotations)) {
        const name = bone.startsWith("Left") ? "Right" + bone.substring(4)
              : bone.startsWith("Right") ? "Left" + bone.substring(5)
              : bone;
        mirrored[name] = new THREE.Quaternion(-q.x, q.y, q.z, -q.w);
    }
    return mirrored;
}

/**
 * Mixamo の骨格の回転を、VRM の正規化された骨の回転に直す。
 *
 * @param {Object<string, THREE.Quaternion>} rotations Mixamo の骨の名前 → 回転
 * @param {import("@pixiv/three-vrm").VRM} vrm
 * @param {object} [reference] T ポーズの基準の向き（調整するとき以外は省略する）
 * @returns {Object<string, THREE.Quaternion>} VRM の骨の名前（leftUpperArm など）→ 回転
 */
export function toVrmRotations(rotations, vrm, reference = TPOSE_REFERENCE) {
    const result = {};
    const isVrm0 = vrm.meta?.metaVersion === "0";
    for (const [bone, q] of Object.entries(rotations)) {
        const vrmBone = mixamoVRMRigMap[`mixamorig${bone}`];
        const rest = reference[bone];
        const parentRest = reference[MIXAMO_PARENTS[bone]];
        if (! vrmBone || ! rest || ! parentRest) {
            continue;
        }
        const converted = new THREE.Quaternion().fromArray(parentRest)
              .multiply(q)
              .multiply(new THREE.Quaternion().fromArray(rest).invert());
        if (isVrm0) {
            // VRM 0.x は前後が逆を向いている（animation-loader.js と同じ扱い）
            converted.x = - converted.x;
            converted.z = - converted.z;
        }
        result[vrmBone] = converted;
    }
    return result;
}

/**
 * Hips の位置を、このモデルの大きさに合わせる。
 *
 * @param {THREE.Vector3} position TalkingHead の Hips.position
 * @param {import("@pixiv/three-vrm").VRM} vrm
 * @returns {THREE.Vector3}
 */
export function toVrmHipsPosition(position, vrm) {
    // 今の姿勢ではなく、基準の姿勢（T ポーズ）での高さを使う。
    // 今の位置を測ると、座っている間は低く出てしまう
    const hipsHeight = vrm.humanoid.normalizedRestPose.hips?.position?.[1] ?? 1.0;
    const scale = hipsHeight / TALKINGHEAD_HIPS_HEIGHT;
    const result = position.clone().multiplyScalar(scale);
    if (vrm.meta?.metaVersion === "0") {
        result.x = - result.x;
        result.z = - result.z;
    }
    return result;
}

/**
 * 止まったポーズを、モーションとして再生できる AnimationClip にする。
 *
 * @param {string} name
 * @param {Object<string, THREE.Quaternion>} vrmRotations toVrmRotations() の結果
 * @param {THREE.Vector3|null} hipsPosition toVrmHipsPosition() の結果
 * @param {import("@pixiv/three-vrm").VRM} vrm
 * @returns {THREE.AnimationClip}
 */
export function createPoseClip(name, vrmRotations, hipsPosition, vrm) {
    // 長さ 0 のクリップは再生の扱いが不安定なので、同じ値を 1 秒並べる
    const times = [0, 1];
    const tracks = [];
    for (const [vrmBone, q] of Object.entries(vrmRotations)) {
        const node = vrm.humanoid.getNormalizedBoneNode(vrmBone);
        if (! node) {
            continue; // このモデルに無い骨（upperChest など）
        }
        tracks.push(new THREE.QuaternionKeyframeTrack(
            `${node.name}.quaternion`, times, [...q.toArray(), ...q.toArray()]));
    }
    if (hipsPosition) {
        const node = vrm.humanoid.getNormalizedBoneNode("hips");
        tracks.push(new THREE.VectorKeyframeTrack(
            `${node.name}.position`, times, [...hipsPosition.toArray(), ...hipsPosition.toArray()]));
    }
    return new THREE.AnimationClip(name, 1, tracks);
}
