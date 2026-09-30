/**
 * ポーズ・ジェスチャーの一覧。
 *
 *   const poses = new PoseLibrary("ポーズ", VrmAvatarElement.poseNames);
 *   await poses.load(POSES_URL);     // animations/poses.json を読む
 *   poses.templateOf("sitting");     // → "sitting"
 *
 * 動きそのもの（骨の角度）は <vrm-avatar> が持っている（TalkingHead の定義）。
 * ここで決めるのは、どれを選択肢に出すか・画面に何という名前で出すか。
 * ポーズとジェスチャーは同じ形なので、このクラスを 2 つ作って使う。
 *
 * ブロックが覚えるのは name ではなく id。名前を直しても、保存済みの
 * アクションの選択が外れないようにするため（効果音などと同じ）
 */

/** 定義の既定の場所。 */
export const POSES_URL = "./animations/poses.json";
export const GESTURES_URL = "./animations/gestures.json";


export default class PoseLibrary {

    /** id → {name, template}。 */
    _entries = new Map();

    /**
     * @param {string} label 警告に出す呼び名（"ポーズ" / "ジェスチャー"）
     * @param {string[]} templateNames 使える動きの名前（<vrm-avatar> が持つもの）
     */
    constructor(label, templateNames) {
        this._label = label;
        this._templateNames = new Set(templateNames);
    }

    /**
     * ブロックのドロップダウンに出すもの。
     * @returns {Array<{id: string, name: string}>}
     */
    get choices() {
        return [...this._entries].map(([id, entry]) => ({id, name: entry.name}));
    }

    /**
     * 何もしていないときの姿勢にする動きの名前。定義で "default": true を
     * 付けたもの（最初の 1 つ）。無ければ undefined
     */
    get defaultTemplate() {
        return [...this._entries.values()].find((entry) => entry.isDefault)?.template;
    }

    /** id から動きの名前を引く。知らない id なら undefined。 */
    templateOf(id) {
        return this._entries.get(String(id))?.template;
    }

    /**
     * 定義を読み込む。
     *
     *   [
     *     {"id": "sitting", "name": "床に座る", "template": "sitting"}
     *   ]
     *
     *   id        アクションが覚える名札。後から変えないこと
     *   name      画面に出す名前
     *   template  動きの名前（TalkingHead のポーズ・ジェスチャーの名前）
     *   default   何もしていないときの姿勢にする（ポーズのみ。1 つだけ付ける）
     *
     * 読めなくても、定義の一部が壊れていても例外は投げない。無くても
     * アプリは会話できるため、警告にとどめて動かし続ける。
     *
     * @param {string} url
     * @returns {Promise<Array<{id: string, name: string}>>} 登録できたもの
     */
    async load(url) {
        let definitions;
        try {
            const response = await fetch(url);
            if (! response.ok) {
                throw new Error(`${response.status}`);
            }
            definitions = await response.json();
        } catch (error) {
            console.warn(`${this._label}の定義 (${url}) を読み込めませんでした`, error);
            return [];
        }

        if (! Array.isArray(definitions)) {
            console.warn(`${this._label}の定義 (${url}) は配列である必要があります`);
            return [];
        }

        for (const definition of definitions) {
            const id = definition?.id;
            const template = definition?.template;
            if (! id || ! template) {
                console.warn(`${this._label}の定義に id か template がありません`, definition);
                continue;
            }
            if (! this._templateNames.has(String(template))) {
                console.warn(`${this._label} "${template}" はありません`, definition);
                continue;
            }
            this._entries.set(String(id), {
                // 名前が無ければ id で代用する（選べなくなるよりはよい）
                name: String(definition.name ?? id),
                template: String(template),
                isDefault: Boolean(definition.default)
            });
        }
        return this.choices;
    }
}
