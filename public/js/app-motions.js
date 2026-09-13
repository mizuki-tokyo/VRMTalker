/**
 * 使えるモーションの定義を読み込む。
 *
 * 定義は animations/motions.json に置く。画面に出す名前とファイルの対応を
 * ここで決めるので、アクションを書く人はファイル名を知らなくてよい。
 *
 *   [
 *     {"name": "立ち姿",     "file": "./animations/vrma/standard_idle.vrma",
 *      "default": true},
 *     {"name": "手を挙げる", "file": "./animations/fbx/Hand Raising.fbx"}
 *   ]
 *
 *   name    画面に出す名前。api.playMotion() に渡す名前でもある
 *   file    モーションファイル（FBX / VRMA）
 *   default ループする待機モーション。1 つだけ指定する
 *
 * JSON にしているのは、将来ビジュアルプログラミングの編集画面が同じものを
 * 読んで選択肢を組み立てるため。アクションのフローも JSON で保存するので、
 * 形式を揃えておく。
 *
 * ここに足したモーションは起動時にすべて読み込む。増やすほど起動が遅くなるので、
 * 使うものだけを載せること。
 */

/** モーション定義の既定の場所。 */
export const MOTIONS_URL = "./animations/motions.json";


/**
 * 定義を読み込んで <vrm-avatar> に登録する。
 *
 * 読めなくても、定義の一部が壊れていても例外は投げない。モーションが
 * 無くてもアプリは会話できるため、警告にとどめて動かし続ける。
 *
 * @param {Element} avatar <vrm-avatar>
 * @param {string} [url]
 * @returns {Promise<string[]>} 登録できたモーション名
 */
const loadMotions = async (avatar, url = MOTIONS_URL) => {
    let definitions;
    try {
        const response = await fetch(url);
        if (! response.ok) {
            throw new Error(`${response.status}`);
        }
        definitions = await response.json();
    } catch (error) {
        console.warn(`モーションの定義 (${url}) を読み込めませんでした`, error);
        return [];
    }

    if (! Array.isArray(definitions)) {
        console.warn(`モーションの定義 (${url}) は配列である必要があります`);
        return [];
    }

    const loaded = [];
    let hasDefault = false;

    for (const definition of definitions) {
        const name = definition?.name;
        const file = definition?.file;
        if (! name || ! file) {
            console.warn("モーションの定義に name か file がありません", definition);
            continue;
        }

        // 既定モーションは 1 つだけ。2 つめ以降は通常のモーションとして扱う
        const isDefault = Boolean(definition.default) && ! hasDefault;
        if (definition.default && hasDefault) {
            console.warn(`既定のモーションが複数あります。"${name}" は通常のモーションにします`);
        }

        try {
            await avatar.loadMotion(file, isDefault, name);
            loaded.push(name);
            hasDefault = hasDefault || isDefault;
        } catch (error) {
            console.warn(`モーション "${name}" (${file}) を読み込めませんでした`, error);
        }
    }

    if (! hasDefault) {
        console.warn("既定のモーションがありません。"
                     + '定義のどれかに "default": true を付けてください');
    }
    return loaded;
};

export default loadMotions;
