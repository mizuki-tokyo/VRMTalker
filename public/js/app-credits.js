/**
 * 謝辞まわり。素材の出典と、3D モデルに埋め込まれた情報を表示する。
 *
 *   await showAcknowledgment();     acknowledgment.md を整形して出す
 *   await showModelInfo(avatar);    VRM のメタ情報を出す
 *
 * どちらも失敗しても例外を投げない。読めなければその旨を出して終わる。
 */

import dialog from "./web-ui/dialog.js";

/** 出典を書くファイル。差し替えるときはここではなく md 側を直す。 */
const ACKNOWLEDGMENT_URL = "./acknowledgment.md";

/**
 * Markdown を整形するライブラリ。押されたときに初めて読み込む。
 *
 * 常時必要なものではないので、起動を重くしない。読み込めなければ
 * 元の文章をそのまま出す（読めなくなるよりはよい）
 */
const MARKED_URL = "https://cdn.jsdelivr.net/npm/marked@15/marked.min.js";

const loadMarked = (() => {
    let loading = null;
    return () => {
        if (loading) {
            return loading;
        }
        loading = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = MARKED_URL;
            script.onload = () => resolve(window.marked);
            script.onerror = () => reject(new Error("marked を読み込めませんでした"));
            document.head.appendChild(script);
        });
        return loading;
    };
})();


/** HTML として差し込む前に、記号を打ち消す。 */
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[c]);


/**
 * 素材の出典を表示する。
 *
 * 中身は自分のサーバに置いた acknowledgment.md だけ。外から来た文字は
 * 通らないので、整形結果をそのまま差し込んでよい
 * （dialog.info の注意書きを参照）
 */
export const showAcknowledgment = async () => {
    let text;
    try {
        const response = await fetch(ACKNOWLEDGMENT_URL);
        if (! response.ok) {
            throw new Error(`${response.status}`);
        }
        text = await response.text();
    } catch (error) {
        console.warn(`${ACKNOWLEDGMENT_URL} を読み込めませんでした`, error);
        await dialog.alert(
            `${ACKNOWLEDGMENT_URL} を読み込めませんでした。\n`
                + "素材の出典はこのファイルに書きます。",
            {title: "リソースの出典"});
        return;
    }

    let html;
    try {
        const marked = await loadMarked();
        html = marked.parse(text);
    } catch (error) {
        // 整形できなくても中身は読める形にしておく
        console.warn(error);
        html = `<pre>${escapeHtml(text)}</pre>`;
    }

    await dialog.info(html, {title: "リソースの出典", okText: "閉じる"});
};


/** VRM 1.0 と VRM 0.x で名前が違うため、拾い方を分けて持つ。 */
const LICENSE_LABELS = Object.freeze({
    // 許諾の値。そのまま出すと意味が取りづらいので日本語にする
    everyone: "だれでも",
    onlyAuthor: "作者のみ",
    explicitlyLicensedPerson: "許可された人のみ",
    personalNonProfit: "個人の非営利のみ",
    personalProfit: "個人なら営利も可",
    corporation: "法人の営利も可",
    required: "必要",
    unnecessary: "不要",
    prohibited: "禁止",
    allowModification: "改変のみ可",
    allowModificationRedistribution: "改変・再配布とも可",
    true: "可",
    false: "不可"
});

const label = (value) => LICENSE_LABELS[String(value)] ?? String(value);

/**
 * VRM のメタ情報を「項目名 → 値」の並びにする。
 *
 * 版によって鍵の名前が違うので、両方から拾って同じ見出しに寄せる。
 * 値の無い項目は落とす（空欄が並ぶと読みづらい）
 */
const collectModelInfo = (meta) => {
    const rows = [];
    const add = (name, value) => {
        if (value !== undefined && value !== null && value !== "") {
            rows.push([name, value]);
        }
    };

    // VRM 1.0 / VRM 0.x
    add("名前", meta.name ?? meta.title);
    add("版", meta.version);
    add("作者", [].concat(meta.authors ?? meta.author ?? []).join(", "));
    add("著作権表示", meta.copyrightInformation);
    add("連絡先", meta.contactInformation);
    add("参照元", [].concat(meta.references ?? meta.reference ?? []).join(", "));

    add("アバターの利用", label(meta.avatarPermission ?? meta.allowedUserName));
    add("クレジット表記", meta.creditNotation && label(meta.creditNotation));
    add("再配布", meta.allowRedistribution !== undefined
        ? label(meta.allowRedistribution) : undefined);
    add("改変", meta.modification && label(meta.modification));
    add("営利利用", label(meta.commercialUsage ?? meta.commercialUssageName));
    add("暴力表現", label(meta.allowExcessivelyViolentUsage ?? meta.violentUssageName));
    add("性的表現", label(meta.allowExcessivelySexualUsage ?? meta.sexualUssageName));
    add("政治・宗教利用", meta.allowPoliticalOrReligiousUsage !== undefined
        ? label(meta.allowPoliticalOrReligiousUsage) : undefined);
    add("反社会的・憎悪利用", meta.allowAntisocialOrHateUsage !== undefined
        ? label(meta.allowAntisocialOrHateUsage) : undefined);

    add("その他の許諾", meta.otherPermissionUrl);
    add("ライセンス", meta.licenseName);
    add("ライセンスの詳細", meta.licenseUrl ?? meta.otherLicenseUrl);
    return rows;
};


/**
 * 3D モデルに埋め込まれた情報を表示する。
 *
 * @param {Element} avatar <vrm-avatar>
 */
export const showModelInfo = async (avatar) => {
    let meta;
    try {
        await avatar.ready;
        meta = avatar.humanoid.getMeta();
    } catch (error) {
        console.warn("モデルの情報を取得できませんでした", error);
        await dialog.alert("モデルを読み込めていないため、情報を表示できません。",
                           {title: "3D モデルの情報"});
        return;
    }

    const rows = collectModelInfo(meta ?? {});
    if (rows.length === 0) {
        await dialog.alert("このモデルには情報が埋め込まれていません。",
                           {title: "3D モデルの情報"});
        return;
    }

    // URL は押せるようにする。それ以外は必ず打ち消してから差し込む
    // （別のタブで開く指定は dialog 側が付ける）
    const cell = (value) => {
        const text = escapeHtml(value);
        return /^https?:\/\/\S+$/.test(value) ? `<a href="${text}">${text}</a>` : text;
    };

    const html = "<table><tbody>"
          + rows.map(([name, value]) =>
              `<tr><th>${escapeHtml(name)}</th><td>${cell(value)}</td></tr>`).join("")
          + "</tbody></table>";

    await dialog.info(html, {title: "3D モデルの情報", okText: "閉じる"});
};
