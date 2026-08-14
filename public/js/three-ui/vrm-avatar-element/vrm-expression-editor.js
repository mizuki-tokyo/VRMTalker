import {
    VRMExpression,
    VRMExpressionMorphTargetBind,
} from "@pixiv/three-vrm";


function _createFaceExpressionMorphTargetBind(vrm, targetName, targetWeight) {

    // MorphTargetBind.primitives に登録するのは Face グループの SkinnedMesh
    const primitives = [...vrm.scene.getObjectByName("Face").children];

    // Faceグループの SkinnedMesh#morphTagetDictionary から、目的の morphTargetIndex を得る
    // Faceグループには Face_(merged) などのSkinnedMesh が登録されている
    const morphTargetDictionary = vrm.scene.getObjectByName("Face").children[0].morphTargetDictionary;

    return new VRMExpressionMorphTargetBind({
        primitives,
        index: morphTargetDictionary[targetName],
        weight: targetWeight,
    });
}

function _registCustomExpressionMorphTargetBindList(vrm, expressionName, expressionMorphTargetBindList) {
    // 表情の参考絵
    // http://fantom1x.blog130.fc2.com/blog-entry-445.html

    const expression = new VRMExpression(expressionName);
    vrm.scene.add(expression);

    for (const expressionMorphTargetBind of expressionMorphTargetBindList) {
        expression.addBind(expressionMorphTargetBind);
    }

    // Expression を登録する(customExpressionMapに追加される)
    vrm.expressionManager.registerExpression(expression);
}

function registFaceExpression(vrm, expressionName, expressionMorphTargetBindMap) {

    const expressionMorphTargetBindList = [];
    for (let morphName in expressionMorphTargetBindMap) {
        expressionMorphTargetBindList.push(
            _createFaceExpressionMorphTargetBind(vrm, morphName, expressionMorphTargetBindMap[morphName]),
        );
    }
    _registCustomExpressionMorphTargetBindList(vrm, expressionName, expressionMorphTargetBindList);
}

export default registFaceExpression;

