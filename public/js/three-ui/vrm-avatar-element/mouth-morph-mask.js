/**
 * 表情から口のモーフを取り除いた版を作る。
 *
 * happy などの感情表情が口のモーフを使っているモデルでは、その表情を出したまま
 * リップシンクすると、口が二重に動いて形が崩れる。
 *
 * 「メッシュが部位ごとに分かれている」ことを前提にすれば、口の Expression が
 * 使うメッシュを丸ごと除外すればよい。しかし実際には happy と aa が同じメッシュを
 * すべて使うモデルがあり、その前提は成り立たない。Bind 単位の除去も同様で、
 * 目・眉と口が 1 つの MorphTarget に同居しているモデルでは、落とせば目の表情まで
 * 消え、残せば口が干渉する（同梱モデルの happy は 1 つの Bind に両方入っている）。
 *
 * そこで頂点単位で判定する。glTF の MorphTarget は相対変位なので、
 *
 *   1. 口の Expression が動かす変位量を、頂点ごとに集める
 *   2. 感情表情の各 Bind について、口と重なる変位の割合を求める
 *   3. 重なっている Bind は、口の変位量に応じて減衰させた MorphTarget を新たに作る
 *   4. それを指す Bind で "<表情名>NoMouth" という Expression を登録する
 *
 * 減衰率には口モーフの変位量そのものを使う。唇から頬へ向かう自然な減衰が
 * そのまま境界のぼかしになるので、0/1 で切ったときのような折れ目が出ない。
 */

import * as THREE from "three";
import {VRMExpression, VRMExpressionMorphTargetBind} from "@pixiv/three-vrm";


/** 口マスク版の表情名につける接尾辞 */
export const MASKED_SUFFIX = "NoMouth";

/** 既定で口マスク版を作る表情 */
export const DEFAULT_MASK_TARGETS = Object.freeze(
    ["happy", "angry", "sad", "relaxed", "surprised"]);

/** expressionManager.mouthExpressionNames が無い場合に使う口の表情名 */
const FALLBACK_MOUTH_NAMES = Object.freeze(["aa", "ih", "ou", "ee", "oh"]);

/** 変位がこれ以下の頂点は動いていないとみなす（VRM の単位はメートル） */
const DISPLACEMENT_EPSILON = 1e-5;

/**
 * 口モーフの最大変位に対してこの割合まで動く頂点は、完全に取り除く。
 * 小さくすると口の周りだけを鋭く抜き、大きくすると広い範囲がなだらかに削れる。
 */
const MOUTH_FEATHER = 0.25;

/**
 * 口との重複がこの割合以下の Bind は、口に触れていないとみなして
 * 元の MorphTarget をそのまま使う（複製しない）
 */
const MOUTH_OVERLAP_MIN = 0.02;


const magnitude = (attribute, index) => Math.hypot(
    attribute.getX(index), attribute.getY(index), attribute.getZ(index));


/**
 * 口の Expression が動かす変位量を、ジオメトリごと・頂点ごとに集める。
 *
 * @param {VRMExpressionManager} expressionManager
 * @returns {Map<string, {max: Float32Array, peak: number}>} geometry.uuid をキーとする
 */
const collectMouthDisplacement = (expressionManager) => {
    const names = expressionManager.mouthExpressionNames || FALLBACK_MOUTH_NAMES;
    const displacements = new Map();

    for (const name of names) {
        const expression = expressionManager.getExpression(name);
        if (! expression) {
            continue;
        }
        for (const bind of expression.binds) {
            if (typeof bind.index !== "number" || ! bind.primitives) {
                continue; // モーフ以外の bind（色・UV など）は変位を持たない
            }
            for (const primitive of bind.primitives) {
                const geometry = primitive.geometry;
                const attribute = geometry?.morphAttributes?.position?.[bind.index];
                if (! attribute) {
                    continue;
                }

                let entry = displacements.get(geometry.uuid);
                if (! entry) {
                    entry = {max: new Float32Array(attribute.count), peak: 0};
                    displacements.set(geometry.uuid, entry);
                }
                for (let i = 0; i < attribute.count; i++) {
                    const value = magnitude(attribute, i);
                    if (value > entry.max[i]) {
                        entry.max[i] = value;
                    }
                    if (value > entry.peak) {
                        entry.peak = value;
                    }
                }
            }
        }
    }
    return displacements;
};


/** 頂点 index に掛ける減衰率。口がよく動く頂点ほど 0 に近づく。 */
const maskScale = (mouth, index) => {
    if (mouth.peak <= 0) {
        return 1;
    }
    return 1 - Math.min(1, mouth.max[index] / (mouth.peak * MOUTH_FEATHER));
};


/**
 * その MorphTarget の変位のうち、口も動かす頂点に乗っている割合。
 * 頂点数ではなく変位量で重み付けする（わずかな巻き込みで誤判定しないように）。
 */
const overlapRatio = (attribute, mouth) => {
    let total = 0;
    let overlap = 0;

    for (let i = 0; i < attribute.count; i++) {
        const value = magnitude(attribute, i);
        if (value <= DISPLACEMENT_EPSILON) {
            continue;
        }
        total += value;
        if (mouth.max[i] > DISPLACEMENT_EPSILON) {
            overlap += value;
        }
    }
    return (total > 0) ? overlap / total : 0;
};


/**
 * 減衰を掛けた MorphTarget 属性を作る。
 * @returns {{attribute: THREE.BufferAttribute, hasMotion: boolean}}
 *          hasMotion が false なら、マスクした結果すべての頂点が動かなくなっている
 */
const maskAttribute = (attribute, mouth) => {
    const itemSize = attribute.itemSize;
    const values = new Float32Array(attribute.count * itemSize);
    let hasMotion = false;

    for (let i = 0; i < attribute.count; i++) {
        const scale = maskScale(mouth, i);
        const offset = i * itemSize;
        for (let component = 0; component < itemSize; component++) {
            const value = attribute.array[offset + component] * scale;
            values[offset + component] = value;
            if (Math.abs(value) > DISPLACEMENT_EPSILON) {
                hasMotion = true;
            }
        }
    }
    return {attribute: new THREE.BufferAttribute(values, itemSize), hasMotion};
};


/**
 * マスクした MorphTarget をジオメトリに追加し、その index を返す。
 *
 * @returns {number|null} マスクすると何も動かなくなる場合は null
 */
const appendMaskedMorphTarget = (primitive, sourceIndex, mouth, name, cache) => {
    const geometry = primitive.geometry;
    const attributes = geometry.morphAttributes;

    // 同じジオメトリを複数のメッシュが共有していることがある。二重に足さない
    const cacheKey = `${geometry.uuid}:${sourceIndex}`;
    if (cache.has(cacheKey)) {
        return cache.get(cacheKey);
    }

    const masked = maskAttribute(attributes.position[sourceIndex], mouth);
    if (! masked.hasMotion) {
        cache.set(cacheKey, null);
        return null;
    }

    attributes.position.push(masked.attribute);
    const index = attributes.position.length - 1;

    // position 以外の morphAttributes も同じ数だけ足しておく。
    // three.js は position の数だけ繰り返して normal / color を無条件に読むため、
    // 数が揃っていないと描画のたびに TypeError になる
    if (attributes.normal) {
        attributes.normal.push(maskAttribute(attributes.normal[sourceIndex], mouth).attribute);
    }
    if (attributes.color) {
        attributes.color.push(maskAttribute(attributes.color[sourceIndex], mouth).attribute);
    }

    cache.set(cacheKey, index);
    return index;
};


/**
 * Bind 1 つ・プリミティブ 1 つぶんの口マスクを作る。
 *
 * @returns {VRMExpressionMorphTargetBind|null} 追加すべき bind。不要なら null
 */
const maskPrimitiveBind = (primitive, bind, displacements, name, cache) => {
    const geometry = primitive.geometry;
    const source = geometry?.morphAttributes?.position?.[bind.index];
    const mouth = displacements.get(geometry?.uuid);

    const passThrough = () => new VRMExpressionMorphTargetBind({
        primitives: [primitive],
        index: bind.index,
        weight: bind.weight
    });

    // 口のモーフが無いジオメトリ、または解釈できない属性はそのまま使う
    if (! source || ! mouth || source.isInterleavedBufferAttribute) {
        return {bind: passThrough(), masked: false};
    }
    if (overlapRatio(source, mouth) <= MOUTH_OVERLAP_MIN) {
        return {bind: passThrough(), masked: false};
    }

    const index = appendMaskedMorphTarget(primitive, bind.index, mouth, name, cache);
    if (index === null) {
        // 口の成分しか無かった。この bind は口マスク版には要らない
        return {bind: null, masked: true};
    }
    if (primitive.morphTargetDictionary) {
        primitive.morphTargetDictionary[name] = index;
    }
    return {
        bind: new VRMExpressionMorphTargetBind({
            primitives: [primitive],
            index,
            weight: bind.weight
        }),
        masked: true
    };
};


/**
 * morphTargetInfluences の要素数を morphAttributes に揃える。
 *
 * ジオメトリを共有するメッシュがあると、MorphTarget を足したジオメトリを
 * 参照している別のメッシュの influences が足りないままになる。
 */
const syncMorphTargetInfluences = (scene) => {
    scene.traverse((object) => {
        const influences = object.morphTargetInfluences;
        const positions = object.geometry?.morphAttributes?.position;
        if (! influences || ! positions) {
            return;
        }
        while (influences.length < positions.length) {
            influences.push(0);
        }
    });
};


/**
 * 口のモーフを取り除いた表情を作って登録する。
 *
 * 元の表情は残したまま "<表情名>NoMouth" を追加する。口に一切触れていない表情や、
 * 口の表情がモーフを使っていないモデル（テクスチャ差し替えなど）では何も作らない。
 *
 * @param {object} vrm
 * @param {{names?: string[]}} [options]
 * @returns {Map<string, string>} 元の表情名 → 口マスク版の表情名
 */
const createMouthMaskedExpressions = (vrm, {names = DEFAULT_MASK_TARGETS} = {}) => {
    const created = new Map();
    const expressionManager = vrm?.expressionManager;
    if (! expressionManager) {
        return created;
    }

    const displacements = collectMouthDisplacement(expressionManager);
    if (displacements.size === 0) {
        return created; // 口の形状をモーフで作っていないモデル
    }

    const cache = new Map();

    for (const name of names) {
        const source = expressionManager.getExpression(name);
        if (! source) {
            continue;
        }
        const maskedName = name + MASKED_SUFFIX;
        if (expressionManager.getExpression(maskedName)) {
            // 既に作ってある。呼び直されても対応表は同じものを返す
            created.set(name, maskedName);
            continue;
        }

        const expression = new VRMExpression(maskedName);
        expression.isBinary = source.isBinary;
        expression.overrideBlink = source.overrideBlink;
        expression.overrideLookAt = source.overrideLookAt;
        // 元の表情が overrideMouth でリップシンクを抑えていることがある。
        // 口マスク版はもう口に触れないので、抑える必要がない
        expression.overrideMouth = "none";

        let masked = false;

        for (const bind of source.binds) {
            if (typeof bind.index !== "number" || ! bind.primitives) {
                expression.addBind(bind); // 色・UV の bind は口に関係しない
                continue;
            }
            for (const primitive of bind.primitives) {
                const result = maskPrimitiveBind(
                    primitive, bind, displacements, maskedName, cache);
                if (result.masked) {
                    masked = true;
                }
                if (result.bind) {
                    expression.addBind(result.bind);
                }
            }
        }

        if (! masked) {
            continue; // 口に触れていない表情。元のままで困らない
        }
        expressionManager.registerExpression(expression);
        created.set(name, maskedName);
    }

    syncMorphTargetInfluences(vrm.scene);
    return created;
};

export default createMouthMaskedExpressions;
