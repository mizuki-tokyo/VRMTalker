# 謝辞

このアプリは、多くの方が公開してくださった素材とソフトウェアで成り立っています。
ありがとうございます。

このファイルを書き換えると、メニューの「リソースの出典」に表示される内容が変わります。
素材を差し替えたときは、ここも合わせて直してください。

---

## 音声合成

**VOICEVOX** — <https://voicevox.hiroshiba.jp/>

利用規約により、実際に使用したキャラクター名のクレジット表記が必要です。
画面の左上に常時表示しています。

## 背景画像

**AIPICT** — <https://aipict.com/>

商用利用・加工可、クレジット表記不要で公開されています
（`public/backgrounds/readme.txt` に利用規約の写しがあります）。

素材としての再配布・販売は禁止されています。背景を差し替えて配布する場合はご注意ください。

## 感情アイコン（エモート）

**感情アイコン色々セット【フリー素材あそび】** —
<https://commons.nicovideo.jp/works/agreement/nc411252>

- 利用許可範囲: インターネット全般
- 権利表記: 任意
- 営利利用: 個人 OK、法人は要連絡

詳細は `public/emotes/README.txt` を参照してください。

## ボイスデータ

**Irodori-TTS** — <https://github.com/Aratako/Irodori-TTS>（MIT License, Copyright (c) 2024 Aratako）

同梱の声は、このソフトウェアで生成したものです。シードによるランダム生成で
最初に出力された「架空の声」を参照音声としてバリエーションを増やしており、
実在する人物の声は参照していません
（`public/voices/README.txt` に詳細があります）。

## 効果音

すべて **freesound.org** で CC0 として公開されているものです
（`public/sounds/readme.txt` に一覧があります）。

| 音 | 作者 |
|---|---|
| 正解 | [Mudkip2016](https://freesound.org/people/Mudkip2016/sounds/423930) |
| 不正解 | [Producing_RayLite](https://freesound.org/people/Producing_RayLite/sounds/700641) |
| 拍手 | [Sandermotions](https://freesound.org/people/Sandermotions/sounds/277021) |
| 笑い声 | [ShangusBurger](https://freesound.org/people/ShangusBurger/sounds/763834) |
| パワーアップ | [JustInvoke](https://freesound.org/people/JustInvoke/sounds/138485) |
| パワーダウン | [JustInvoke](https://freesound.org/people/JustInvoke/sounds/138488) |

## ポーズとジェスチャー

**TalkingHead** — <https://github.com/met4citizen/TalkingHead>（MIT License, Copyright (c) 2023-2024 Mika Suominen）

ポーズ（全身の姿勢）とジェスチャー（腕と手の身ぶり）の角度の定義は、
このソフトウェアのものを使っています。VRM で使えるように変換する処理は
このアプリで書いたものです（`public/js/three-ui/vrm-avatar-element/talkinghead-templates.js`
に、許諾表示とともに定義の写しがあります）。

## モーション
### おじぎ
[virtual-avatar-sdk プロジェクト](https://github.com/hirokazuniimoto/virtual-avatar-sdk)に含まれているモーションです（MIT ライセンス）。頭を上げた後の、動きの無い部分（約 5 秒）を切り詰めて使っています。

### 歩く、軽く走る、走る
Josie - Character Model のモーション（CC0）を
sashii さんが VRM にリターゲティングしたモーション（CC0）です。

**BOOTH の配布サイト** — <https://booth.pm/en/items/7861818>

## 3D モデル

同梱のモデルの作者・利用許諾は、モデル自身に埋め込まれています。
メニューの「3D モデルの情報」から確認できます。

## フォント

**LINE Seed JP** — <https://seed.line.me/index_jp.html>

---

## ソフトウェア

| 名前 | 用途 |
|---|---|
| [three.js](https://threejs.org/) | 3D 表示 |
| [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) | VRM の読み込みと制御 |
| [Blockly](https://developers.google.com/blockly) | ブロックの編集画面 |
| [marked](https://marked.js.org/) | このページの表示 |
| [Lucide](https://lucide.dev/) | アイコン |
| [FastAPI](https://fastapi.tiangolo.com/) | サーバ |



