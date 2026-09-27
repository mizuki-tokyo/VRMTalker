/**
 * ボイスデータの一覧。
 *
 *   const voices = new VoiceLibrary();
 *   await voices.load();            // voices/voices.json を読む
 *   voices.fileOf("hello");         // → "./voices/hello.mp3"
 *
 * 鳴らすのはここではなく <vrm-avatar> の仕事。アバターの発話として鳴らすと
 * 口が動く（リップシンク）。効果音（sound-player.js）とはそこが違う。
 *
 *   ボイスデータ  アバターが喋る。口が動く。「話すのをやめる」で止まる
 *   効果音        場面の音。口は動かない。重ねて鳴らせる
 *
 * ブロックが覚えるのは name ではなく id。名前は画面に出す文そのもの
 * （「こんにちは！」）なので、後から文言を直したくなる。id を分けておけば、
 * 直しても保存済みのアクションの選択が外れない
 */

/** ボイスデータの定義の既定の場所。 */
export const VOICES_URL = "./voices/voices.json";


export default class VoiceLibrary {

    /** id → {name, file}。 */
    _voices = new Map();

    /**
     * ブロックのドロップダウンに出すもの。
     * @returns {Array<{id: string, name: string}>}
     */
    get choices() {
        return [...this._voices].map(([id, voice]) => ({id, name: voice.name}));
    }

    /** id から音のファイルを引く。知らない id なら undefined。 */
    fileOf(id) {
        return this._voices.get(String(id))?.file;
    }

    /**
     * 定義を読み込む。
     *
     *   [
     *     {"id": "hello", "name": "こんにちは！", "file": "./voices/hello.mp3"}
     *   ]
     *
     *   id    アクションが覚える名札。後から変えないこと
     *   name  画面に出す文
     *   file  音のファイル
     *
     * 読めなくても、定義の一部が壊れていても例外は投げない。ボイスデータが
     * 無くてもアプリは会話できるため、警告にとどめて動かし続ける。
     *
     * @param {string} [url]
     * @returns {Promise<Array<{id: string, name: string}>>} 登録できたもの
     */
    async load(url = VOICES_URL) {
        let definitions;
        try {
            const response = await fetch(url);
            if (! response.ok) {
                throw new Error(`${response.status}`);
            }
            definitions = await response.json();
        } catch (error) {
            console.warn(`ボイスデータの定義 (${url}) を読み込めませんでした`, error);
            return [];
        }

        if (! Array.isArray(definitions)) {
            console.warn(`ボイスデータの定義 (${url}) は配列である必要があります`);
            return [];
        }

        for (const definition of definitions) {
            const id = definition?.id;
            const file = definition?.file;
            if (! id || ! file) {
                console.warn("ボイスデータの定義に id か file がありません", definition);
                continue;
            }
            this._voices.set(String(id), {
                // 名前が無ければ id で代用する（選べなくなるよりはよい）
                name: String(definition.name ?? id),
                file: String(file)
            });
        }
        return this.choices;
    }
}
