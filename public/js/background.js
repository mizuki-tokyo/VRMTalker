/**
 * 背景の絵を差し替える。
 *
 *   const background = new Background(document.querySelector("#screen"));
 *   await background.load();        // backgrounds/backgrounds.json を読む
 *   background.set("beach");        // 読み込めた時点で切り替わる
 *
 * 最初に出す絵は index.html が決める（#screen の style）。起動してから
 * JavaScript で決めると、読み込みが終わるまで背景の無い画面が見えてしまう。
 * ここが持つのは「あとから切り替えられる絵の一覧」で、その中に最初の絵を
 * 入れておくと、切り替えたあとで元に戻せる。
 *
 * 絵は先に読み込んでから差し替える。1 枚 1MB を超えることがあり、そのまま
 * CSS へ渡すと、読み込みが終わるまで背景が消えて画面が白く抜ける。
 *
 * 切り替えは溶け込ませる。#screen::after に次の絵を入れて透明から不透明へ
 * 変え、変わり切ったところで #screen 自身の背景へ移す。速さと見え方は
 * index.html の CSS が決めるので、ここでは終わりの合図を待つだけにする。
 *
 * 渡すのは定義の id。知らない id でも例外は投げない。アクションが途中で
 * 止まらないよう、警告を出して何もしない（呼び出し側の app-avatar-api.js の約束）。
 */

/** 背景の定義の既定の場所。 */
export const BACKGROUNDS_URL = "./backgrounds/backgrounds.json";

/**
 * 切り替えの終わりを待つ上限（ミリ秒）。
 *
 * transition が走らない場合（拡張機能や設定で無効にされている等）に、終わりの
 * 合図を待ち続けないための保険。CSS で決めた時間より十分に長くしておくこと。
 * 短くすると、変化の途中で下の層へ移してしまう。
 *
 * ここに至っても見た目は正しい（重ねた層に次の絵が出ている）。遅れるのは
 * 後片付けだけなので、長めで構わない
 */
const FADE_TIMEOUT = 10000;


export default class Background {

    /** id → {name, file}。 */
    _backgrounds = new Map();

    /** 切り替えの途中にある絵。終わったら null に戻す。 */
    _fading = null;

    /**
     * @param {Element} element 背景を出す要素（#screen）
     */
    constructor(element) {
        this._element = element;
    }

    /**
     * 選べる背景。ブロックの選択肢に使う。
     * @returns {Array<{id: string, name: string}>}
     */
    get choices() {
        return [...this._backgrounds].map(([id, item]) => ({id, name: item.name}));
    }

    /**
     * 定義を読み込む。
     *
     *   [
     *     {"id": "beach", "name": "ビーチ", "file": "./backgrounds/beach.png"}
     *   ]
     *
     *   id    アクションが覚える名札。set() に渡すのもこれ。後から変えないこと
     *   name  画面に出す文字
     *   file  絵のファイル
     *
     * 読めなくても、定義の一部が壊れていても例外は投げない。背景を替えられ
     * なくてもアプリは会話できるため、警告にとどめて動かし続ける。
     *
     * @param {string} [url]
     * @returns {Promise<Array<{id: string, name: string}>>} 登録できたもの
     */
    async load(url = BACKGROUNDS_URL) {
        let definitions;
        try {
            const response = await fetch(url);
            if (! response.ok) {
                throw new Error(`${response.status}`);
            }
            definitions = await response.json();
        } catch (error) {
            console.warn(`背景の定義 (${url}) を読み込めませんでした`, error);
            return [];
        }

        if (! Array.isArray(definitions)) {
            console.warn(`背景の定義 (${url}) は配列である必要があります`);
            return [];
        }

        for (const definition of definitions) {
            const id = definition?.id;
            const file = definition?.file;
            if (! id || ! file) {
                console.warn("背景の定義に id か file がありません", definition);
                continue;
            }
            // 名前が無ければ id で代用する（選べなくなるよりはよい）
            this._backgrounds.set(String(id), {
                name: String(definition.name ?? id), file: String(file)
            });
        }
        return this.choices;
    }

    /**
     * 背景を替える。
     *
     * 絵を読み込んでから、溶け込ませて切り替える。読み込めなければ今の背景の
     * ままにする（消えた画面を見せるより、替わらないほうがまだ分かる）。
     *
     * @param {string} id
     * @returns {Promise<void>} 切り替わり切った時点で解決する
     */
    async set(id) {
        const file = this._backgrounds.get(String(id))?.file;
        if (! file) {
            console.warn(`背景 "${id}" がありません`);
            return;
        }

        try {
            await this._preload(file);
        } catch (error) {
            console.warn(`背景 "${id}" (${file}) を読み込めませんでした`);
            return;
        }
        await this._fadeTo(file);
    }

    //---------------------------------- 内部

    /** 絵を先に読み込む。ブラウザのキャッシュに入るので、差し替えは一瞬で済む。 */
    _preload(file) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve();
            image.onerror = () => reject(new Error(file));
            image.src = file;
        });
    }

    /** 重ねた層を透明から不透明へ変えて、変わり切ったら下へ移す。 */
    async _fadeTo(file) {
        const element = this._element;

        // 続けて呼ばれたときは、途中だった絵をここで確定させる。
        // 2 つを重ねて動かすと、どちらが最後なのか分からなくなる
        this._commit();

        element.style.setProperty("--next-background", `url('${file}')`);
        this._fading = file;

        // 一度描かせてから class を付ける。同じ回で値と class を変えると、
        // 変化前の状態が無かったことになり、transition が始まらない
        await new Promise((resolve) => requestAnimationFrame(resolve));
        element.classList.add("is-fading");

        await this._waitForFade();
        this._commit();
    }

    /** 重ねた層の変化が終わるのを待つ。 */
    _waitForFade() {
        const element = this._element;
        return new Promise((resolve) => {
            const finish = () => {
                element.removeEventListener("transitionend", onEnd);
                clearTimeout(timer);
                resolve();
            };
            // #screen の中では吹き出しなども透明度を変える。それらの合図は
            // 昇ってくるだけなので、重ねた層のものだけを拾う
            const onEnd = (event) => {
                if (event.target === element
                    && event.pseudoElement === "::after"
                    && event.propertyName === "opacity") {
                    finish();
                }
            };
            const timer = setTimeout(finish, FADE_TIMEOUT);
            element.addEventListener("transitionend", onEnd);
        });
    }

    /**
     * 重ねた層の絵を #screen 自身の背景にして、層を透明に戻す。
     *
     * 同じ絵が上下に並んだ状態で入れ替えるので、継ぎ目は見えない。
     * 2 つの変更を 1 回でまとめて行うこと（間に描画を挟むと絵が消える）
     */
    _commit() {
        if (! this._fading) {
            return;
        }
        const element = this._element;
        element.style.backgroundImage = `url('${this._fading}')`;
        element.classList.remove("is-fading");
        element.style.removeProperty("--next-background");
        this._fading = null;
    }
}
