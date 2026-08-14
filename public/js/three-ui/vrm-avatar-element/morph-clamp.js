/**
 * 表情が使うモーフの合計値を制限する（限界突破の防止）。
 *
 * three-vrm の VRMExpressionMorphTargetBind#applyWeight は加算のみで、
 * 上限を設けていない。
 *
 *     mesh.morphTargetInfluences[this.index] += this.weight * weight;
 *
 * VRMExpressionManager#update() は「全 bind を 0 にしてから各表情を順に加算」
 * するだけなので、複数の表情が同じモーフを指すと合計がそのまま足し合わされる。
 * 例えば happy が目のモーフを 0.8 使っている状態で blink が 1.0 を加えると
 * 合計 1.8 となり、頂点が意図しない位置まで移動してしまう。
 *
 * VRM 仕様には overrideBlink / overrideLookAt / overrideMouth という抑制の
 * 仕組みがあるが、VRM 0.0 では使えず、blink / lookAt / mouth の 3 系統しか
 * 救えない。そこでモデルに依存しない最後の安全網として、update() の後に
 * 最終値を丸める。
 */

/**
 * expressionManager.update() をラップして、表情が触るモーフの値を
 * [min, max] に収めるようにする。
 *
 * @param {object} vrm
 * @param {{min?: number, max?: number}} [options]
 * @returns {() => void} 元に戻す関数
 */
const clampExpressionMorphs = (vrm, {min = 0, max = 1} = {}) => {
    const expressionManager = vrm?.expressionManager;
    if (! expressionManager) {
        return () => {};
    }

    /**
     * 表情が実際に結びついているモーフだけを集める。
     * シーン中の全モーフを一律に丸めると、表情以外の用途を壊しかねない。
     */
    const collectTargets = () => {
        const targets = new Map(); // mesh -> Set<index>
        for (const expression of expressionManager.expressions) {
            // binds は public アクセサ（_binds の getter）
            for (const bind of expression.binds) {
                if (bind.index === undefined || ! bind.primitives) {
                    continue; // モーフ以外の bind（色・UV など）は対象外
                }
                for (const mesh of bind.primitives) {
                    if (! targets.has(mesh)) {
                        targets.set(mesh, new Set());
                    }
                    targets.get(mesh).add(bind.index);
                }
            }
        }
        return [...targets].map(([mesh, indices]) => [mesh, [...indices]]);
    };

    let entries = [];
    let knownExpressionCount = -1;

    const original = expressionManager.update.bind(expressionManager);

    expressionManager.update = () => {
        original();

        // 表情は後から registerExpression() で増えることがある。
        // 数が変わったときだけ集め直す（毎フレームの走査は避ける）
        if (expressionManager.expressions.length !== knownExpressionCount) {
            knownExpressionCount = expressionManager.expressions.length;
            entries = collectTargets();
        }

        for (const [mesh, indices] of entries) {
            const influences = mesh.morphTargetInfluences;
            if (! influences) {
                continue;
            }
            for (const index of indices) {
                const value = influences[index];
                if (value > max) {
                    influences[index] = max;
                } else if (value < min) {
                    influences[index] = min;
                }
            }
        }
    };

    return () => {
        expressionManager.update = original;
    };
};

export default clampExpressionMorphs;
