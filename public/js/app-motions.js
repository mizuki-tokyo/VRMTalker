/**
 * 使えるモーションの定義を読み込む。
 *
 * 定義は animations/motions.json に置く。名前とファイルの対応をここで決める
 * ので、アクションを書く人はファイル名を知らなくてよい。
 *
 *   [
 *     {"id": "idle",         "name": "立ち姿",     "default": true,
 *      "file": "./animations/vrma/standard_idle.vrma"},
 *     {"id": "hand-raising", "name": "手を挙げる",
 *      "file": "./animations/fbx/Hand Raising.fbx"}
 *   ]
 *
 *   id      アクションが覚える名札。api.playMotion() に渡すのもこれ。
 *           後から変えないこと（保存済みのアクションが外れる）
 *   name    画面に出す文字。変えても保存済みのアクションに響かない
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
 * @returns {Promise<Array<{id: string, name: string}>>} 登録できたもの
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
        const id = definition?.id;
        const file = definition?.file;
        if (! id || ! file) {
            console.warn("モーションの定義に id か file がありません", definition);
            continue;
        }
        // 名前が無ければ id で代用する（選べなくなるよりはよい）
        const name = String(definition.name ?? id);

        // 既定モーションは 1 つだけ。2 つめ以降は通常のモーションとして扱う
        const isDefault = Boolean(definition.default) && ! hasDefault;
        if (definition.default && hasDefault) {
            console.warn(`既定のモーションが複数あります。"${id}" は通常のモーションにします`);
        }

        try {
            // <vrm-avatar> には id で覚えさせる。api.playMotion() が渡すのも id
            await avatar.loadMotion(file, isDefault, String(id));
            loaded.push({id: String(id), name});
            hasDefault = hasDefault || isDefault;
        } catch (error) {
            console.warn(`モーション "${id}" (${file}) を読み込めませんでした`, error);
        }
    }

    if (! hasDefault) {
        console.warn("既定のモーションがありません。"
                     + '定義のどれかに "default": true を付けてください');
    }
    return loaded;
};

export default loadMotions;
