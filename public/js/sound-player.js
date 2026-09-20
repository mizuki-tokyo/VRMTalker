/**
 * 効果音を鳴らす。
 *
 *   const sounds = new SoundPlayer();
 *   await sounds.load();               // sounds/sounds.json を読む
 *   sounds.play("拍手");               // 鳴らし始めて、すぐ次へ進む
 *   await sounds.playAndWait("拍手");  // 鳴り終わるまで待つ
 *   sounds.stop();                     // 鳴っているものを全部止める
 *
 * 鳴らすたびに新しい再生を始める（ワンショット）。前の音を待たないので、
 * 同じ音でも重なって鳴る。拍手の上に正解音を重ねる、といった使い方ができる。
 *
 * 知らない名前を渡しても例外は投げない。アクションが途中で止まらないよう、
 * 警告を出して何もしない（呼び出し側の app-avatar-api.js の約束）。
 *
 * 音声合成の発話とは別系統で、互いに止め合わない。発話は <vrm-avatar> が
 * 口の動きと一緒に面倒を見る
 */

/** 効果音の定義の既定の場所。 */
export const SOUNDS_URL = "./sounds/sounds.json";


export default class SoundPlayer {

    /** 名前 → 音のファイル。 */
    _files = new Map();

    /**
     * 先読み用の <audio>。捨てると読み込みも止まるので持っておく。
     * 鳴らすときは別の <audio> を作るが、ファイルはキャッシュから取れる
     */
    _preloaded = [];

    /** 今鳴っているもの。{audio, settle} の集まり。 */
    _playing = new Set();

    /** 鳴らせる音の名前。ブロックの選択肢に使う。 */
    get names() {
        return [...this._files.keys()];
    }

    /**
     * 定義を読み込む。
     *
     *   [
     *     {"name": "拍手", "file": "./sounds/applause.mp3"}
     *   ]
     *
     *   name  画面に出す名前。play() に渡す名前でもある
     *   file  音のファイル
     *
     * 読めなくても、定義の一部が壊れていても例外は投げない。効果音が無くても
     * アプリは会話できるため、警告にとどめて動かし続ける。
     *
     * @param {string} [url]
     * @returns {Promise<string[]>} 登録できた名前
     */
    async load(url = SOUNDS_URL) {
        let definitions;
        try {
            const response = await fetch(url);
            if (! response.ok) {
                throw new Error(`${response.status}`);
            }
            definitions = await response.json();
        } catch (error) {
            console.warn(`効果音の定義 (${url}) を読み込めませんでした`, error);
            return [];
        }

        if (! Array.isArray(definitions)) {
            console.warn(`効果音の定義 (${url}) は配列である必要があります`);
            return [];
        }

        for (const definition of definitions) {
            const name = definition?.name;
            const file = definition?.file;
            if (! name || ! file) {
                console.warn("効果音の定義に name か file がありません", definition);
                continue;
            }
            this._files.set(String(name), String(file));
            this._preload(String(name), String(file));
        }
        return this.names;
    }

    /** 鳴らす。鳴り終わるのを待たない。 */
    play(name) {
        this._start(name);
    }

    /**
     * 鳴らして、鳴り終わるまで待つ。
     *
     * stop() で止められた場合もそこで解決する（待ち続けない）。
     *
     * @returns {Promise<void>}
     */
    async playAndWait(name) {
        const started = this._start(name);
        if (started) {
            await started.finished;
        }
    }

    /** 鳴っているものを全部止める。待っている呼び出し元も解放する。 */
    stop() {
        for (const entry of [...this._playing]) {
            this._finish(entry);
        }
    }

    //---------------------------------- 内部

    /**
     * ファイルをあらかじめ取りに行く。押した瞬間に鳴ってほしいため。
     * ついでに、置き忘れたファイルをここで見つけられる
     */
    _preload(name, file) {
        const audio = new Audio(file);
        audio.preload = "auto";
        audio.addEventListener("error", () => {
            console.warn(`効果音 "${name}" (${file}) を読み込めませんでした`);
        }, {once: true});
        this._preloaded.push(audio);
    }

    /**
     * 1 つ鳴らし始める。
     * @returns {{audio: HTMLAudioElement, finished: Promise<void>}|null}
     */
    _start(name) {
        const file = this._files.get(String(name));
        if (! file) {
            console.warn(`効果音 "${name}" がありません`);
            return null;
        }

        const audio = new Audio(file);
        let settle;
        const finished = new Promise((resolve) => {
            settle = resolve;
        });
        const entry = {audio, settle};
        this._playing.add(entry);

        audio.addEventListener("ended", () => this._finish(entry), {once: true});
        audio.addEventListener("error", () => this._finish(entry), {once: true});
        audio.play().catch((error) => {
            console.warn(`効果音 "${name}" を鳴らせませんでした`, error);
            this._finish(entry);
        });

        return {audio, finished};
    }

    /** 1 つ止めて、待っている呼び出し元を解放する。二度呼んでも害は無い。 */
    _finish(entry) {
        if (! this._playing.delete(entry)) {
            return;
        }
        entry.audio.pause();
        entry.settle();
    }
}
