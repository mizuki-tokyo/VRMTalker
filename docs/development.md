# 開発者向けの情報

VRMTalker の中の作りと、改造するときに知っておくとよいことをまとめる。
使い方は [README](../README.md)、サーバーとしての公開は [deployment.md](deployment.md) を参照。

- サーバーは Python + FastAPI、画面は素の Web Components（フレームワークを使わない）
- ブラウザで使うライブラリは `public/vendor/` に同梱し、CDN からは読まない

## 構成

アプリケーションのソースは `src/` にまとめ、ルートには利用者が直接実行するもの
（エントリポイントの `main.py` とセットアップスクリプト）だけを置いている。

`src/` はパッケージルートとして venv に入る（`pyproject.toml` の
`[tool.hatch.build.targets.wheel]` を参照）ため、`main.py` からは
`import tts` / `from llm import ...` のように書ける。

```
main.py                     FastAPI アプリ（エントリポイント）
start.sh                    .env を読み込んで起動する
scripts/
  setup_voicevox.py         VOICEVOX 一式の取得
  setup_llama.py            llama.cpp と GGUF モデルの取得
  setup_vendor.py           ブラウザで使うライブラリの取得（public/vendor/）
src/
  project_paths.py          プロジェクトルートの解決
  tts.py                    VOICEVOX CORE のラッパー
  llama_server.py           同梱 llama-server の起動・停止
  llm/
    base.py                 ChatModel（抽象基底）と Message
    openai_compat.py        OpenAI 互換 API の実装
    echo.py                 LLM 無しで動かすダミー実装
    __init__.py             環境変数から実装を組み立てる。システムプロンプトと感情の推定
data/                       公開されたアクション（配布物には含めない）
docs/                       開発者・運用者向けの文書
public/
  index.html
  actions.json              同梱のアクション（読み取り専用の見本）
  acknowledgment.md         素材とソフトウェアの出典
  animations/  emotes/  sounds/  voices/  backgrounds/  models/   素材と、その定義ファイル
  icons/                    画面に出す絵（考え中の吹き出し）と、使い回すアイコン（icon-list.svg）
  vendor/                   ブラウザで使うライブラリ（版ごとのフォルダ。ライセンスの写し付き）
  styles/
    blockly.css             Blockly の見た目（他のプロジェクトでも使える分）
  js/
    app.js                  アプリ全体の組み立て
    app-conversation.js     会話の進行（節目をイベントで出す）
    app-avatar-actions.js   節目ごとの動き（手書き。JSON が無いときの控え）
    app-avatar-api.js       アクションから呼べる関数（＝ブロック 1 個ぶん）
    app-action-program.js   ブロックの JSON を読んで動かす
    app-action-runner.js    アクションの実行と中断
    app-blocks.js           ブロックの文言・形・パレット
    app-block-editor.js     編集画面（Blockly の組み立てと読み書き）
    app-block-warnings.js   つまずきやすい組み方に、編集画面で警告を付ける
    app-motions.js          motions.json の読み込み
    poses.js                poses.json / gestures.json の読み込み
    sound-player.js         効果音
    voices.js               ボイスデータの一覧
    background.js           背景の切り替え
    icons.js                icon-list.svg のアイコンを要素として作る
    emotion.js              返事の感情（LLM が付ける絵文字）の読み取り
    app-settings.js         設定ウインドウの中身
    app-credits.js          謝辞（出典とモデル情報）
    speech-synthesizer.js   /api/tts のクライアント
    chat-client.js          /api/chat のクライアント（文単位で返す）
    split-sentence.js       文の分割
    speech-recognizer.js    音声認識の実装が守る約束（SpeechRecognizer）
    web-speech-recognizer.js  ボタンを押すたびに 1 回聞き取る音声認識
    speech-hands-free/      連続対話（Silero VAD で発話を見つけ、音声認識に渡す）
    three-ui/               3D まわりのカスタム要素
      three-world-element.js  <three-world>  three.js の描画環境
      vrm-avatar-element.js   <vrm-avatar>   VRM モデルの配置と制御
      vrm-avatar-element/     VRM 固有の処理（ローダ、モーション、リップシンク、
                              ポーズとジェスチャー、ボーン名の対応表）
      vrm-head-sprite-element.js  頭の上に絵を出す要素の土台（次の 2 つが継承する）
      vrm-emote-element.js    <vrm-emote>    頭の上のアイコン
      vrm-thinking-element.js <vrm-thinking> 返事を考えている間の吹き出し
    web-ui/                 画面部品のカスタム要素（吹き出し・設定・ダイアログ等）
```

## API

| メソッド | パス | 内容 |
|---|---|---|
| `GET` | `/api/status` | 各機能が使える状態か |
| `GET` | `/api/speakers` | 利用可能なキャラクターとスタイルの一覧 |
| `POST` | `/api/tts` | `{"text": "...", "style_id": 2}` → `audio/wav` |
| `POST` | `/api/chat` | `{"text": "...", "history": [...]}` → SSE で応答を逐次返す |
| `GET` | `/api/actions` | 公開されているアクションの一覧（素性だけ） |
| `GET` | `/api/actions/{id}` | アクションを 1 つ。`id` は `default` か UUID |
| `POST` | `/api/actions` | アクションを公開する（合言葉が要る） |

`/api/chat` は生成の完了を待たずに差分を流す。ブラウザ側（`chat-client.js`）は
文が完成した時点で音声合成に回すため、最初の発話までの待ち時間が短くなる。

## LLM へのアクセス

LLM へのアクセスは `src/llm/base.py` の `ChatModel` で抽象化してある。
利用側（`main.py`）は具体的な実装を知らない。

| 実装 | 用途 |
|---|---|
| `OpenAICompatChat` | 同梱の llama-server（ローカル）、および OpenAI / vLLM / Ollama などサーバ側 LLM |
| `EchoChat` | LLM 無しで動かすためのダミー。復唱するだけ |

どれを使うかは環境変数 `LLM_BACKEND` で決まる（変数の一覧は
[README](../README.md#llm-を切り替える) を参照）。`local` のときだけ、
同梱の llama-server を子プロセスとして自動起動する。

## 既定の話者を変える

利用者は設定ウインドウの「話者」で選べる。設定を保存していないときに使う
既定の話者は、[public/js/speech-synthesizer.js](../public/js/speech-synthesizer.js) の
`_styleId` で決まる（設定の「破棄」で戻る先も、この話者）。選べる番号は
`/api/speakers` の `style_id`。

## ブラウザのライブラリの版を上げる

three.js、three-vrm、Blockly、marked、ONNX Runtime Web と Silero VAD のモデルは
`public/vendor/` に同梱してある（版ごとのフォルダ）。版を上げるときは
`scripts/setup_vendor.py` の版を書き換えて実行し、読み込む側の参照
（`index.html` の importmap、`app-block-editor.js`、`app-credits.js`、
`speech-hands-free/silero-vad.js`）も書き換える。

## アバター（VRM モデル）を差し替える

アバターは `public/index.html` の `<vrm-avatar>` で指定している。VRM 0.0 と
VRM 1.0 のどちらのモデルも使える（向きや表情の名前の違いは、読み込むときに吸収する）。

```html
<vrm-avatar src="./models/ChibiVita.vrm"
            position="0, 0, 0"
            light-intensity="1.8"
            shadow="0.3">
  <vrm-emote ... size="0.28" offset="0.18, 0.28, 0" pop></vrm-emote>
  <vrm-thinking ... size="0.28" offset="-0.18, 0.28, 0" fade="0.3" pop></vrm-thinking>
</vrm-avatar>
```

1. モデルのファイル（`.vrm`）を `public/models/` に置き、`src` をそのファイルに書き換える
2. モデルの利用条件（改変・再配布・商用利用など）を確かめる。モデルに埋め込まれた
   利用条件は、起動後にメニューの「3D モデルの情報」で見られる（`app-credits.js`）
3. `public/acknowledgment.md` の出典を直す（メニューの「リソースの出典」に出る）

差し替えたモデルでも、そのまま動くものと、調整が要るかもしれないものは次のとおり。

| 項目 | 差し替えたときの扱い |
|---|---|
| モーション・ポーズ・ジェスチャー | VRM のヒューマノイドボーンに合わせて動かすので、そのまま使える |
| 表情 | ブロックは VRM 1.0 のプリセット名（`happy` `angry` `sad` `relaxed` `surprised`）で指定する。VRM 0.0 の名前（`Joy` など）は自動で読み替え、モデルに無い表情（VRM 0.0 の `surprised` など）は近い表情で代わりにする（`expression-name.js`） |
| 表情とリップシンク | 感情の表情が口のモーフも動かすモデルでは、口のモーフを取り除いた版の表情を自動で作る（`mask-mouth-expressions`、既定で有効） |
| 頭の上の絵（エモート・考え中の吹き出し） | 頭のボーンの位置からのずれ（`offset`、メートル）と大きさ（`size`）で置いている。頭の大きさや形が違うモデルでは、`<vrm-emote>` と `<vrm-thinking>` の `offset` と `size` を調整する |
| カメラ | 頭のボーンに寄るので、そのまま使える。寄り方は `focus` と `camera-distance` で変える（下の「カメラの寄り先を変える」） |
| 位置・明るさ | `position`（初期位置 "x, y, z"）と `light-intensity`（モデル用の補助ライトの強さ。0 または未指定なら追加しない）で調整する |
| 影 | 足元の平面の位置と大きさをモデルから決めるので、そのまま使える |

`position` / `focus` / `camera-distance` / `shadow` / `clamp-morphs` / `light-intensity`
は、読み込んだ後に書き換えても画面に反映される（ブラウザの開発者ツールで値を
試してから、`index.html` に書くと楽）。`src` と `mask-mouth-expressions` は、
読み込むときに一度だけ読む。

## `<vrm-avatar>` の属性

### カメラの寄り先を変える

`OrbitControls` はズームを注視点（`controls.target`）へ向かって行うため、
「ズームインしたときに何が見えるか」は注視点で決まる。

`<vrm-avatar>` は読み込み後に、VRM ヒューマノイドボーンのワールド座標を注視点に設定する。
`head` などのボーンは VRM 仕様で必須なので、**モデルを差し替えても同じ部位を狙える**。

```html
<vrm-avatar src="./models/xxx.vrm"
            focus="head"              <!-- 既定。ズームインすると頭部に寄る -->
            camera-distance="1.5">    <!-- 省略するとモデル全体が収まる距離を自動計算 -->
</vrm-avatar>
```

| 属性 | 既定 | 内容 |
|---|---|---|
| `focus` | `head` | 注視点にする VRM ヒューマノイドボーン名。`none` で無効 |
| `camera-distance` | 自動 | カメラまでの距離。省略時はモデル全体が画面に収まる距離を計算する |

既定ではモデル全体が入るため、頭部が画面中央に来るぶん上側に余白ができる。
上半身に寄せたい場合は `camera-distance` を小さくする。

実行中に変えることもできる。

```js
document.querySelector("vrm-avatar").focusCamera("chest");
```

### 表情モーフの限界突破を防ぐ

three-vrm は複数の表情が同じモーフを指すと単純に加算する。例えば happy が目のモーフを
0.8 使っている状態で blink が 1.0 を加えると合計 1.8 になり、頂点が意図しない位置まで
動いてしまう。

`<vrm-avatar>` は既定でこれを防ぐ（`update()` 後に合計値を 1.0 で丸める）。

```html
<vrm-avatar src="./models/xxx.vrm" clamp-morphs="1.0"></vrm-avatar>
<vrm-avatar src="./models/xxx.vrm" clamp-morphs="off"></vrm-avatar>  <!-- 無効化 -->
```

| 値 | 動作 |
|---|---|
| 未指定 | 有効。上限 1.0 |
| 数値 | 有効。その値を上限にする |
| `off` / `none` | 無効 |

対象は表情が実際に結びついているモーフだけで、それ以外は触らない。

VRM 仕様には `overrideBlink` / `overrideLookAt` / `overrideMouth` という抑制の仕組みも
あり、「笑顔のときは目を閉じない」といった意味論を表現できる。ただし VRM 0.0 では
使えず、blink / lookAt / mouth の 3 系統しか救えないため、モデルに依存しない
安全網としてクランプを併用している。

### 影をつける

`<vrm-avatar>` に `shadow` を指定すると、モデルが影を落とし、足元に置いた
透明な平面がそれを受ける。平面の位置と大きさはモデルのバウンディングボックスから
決めるので、体格の違うモデルに差し替えても足元に合う。

```html
<vrm-avatar src="./models/xxx.vrm" shadow="0.3"></vrm-avatar>
```

値は影の濃さ（0-1、既定 0.3）。`shadow` だけ書いても既定値で有効になる。

実装は次のように分かれている。

| 担当 | 内容 |
|---|---|
| `<three-world>` | `renderer.shadowMap` と光源の設定（`enableShadows()` / `fitShadowCamera()`） |
| `<vrm-avatar>` | モデルへの `castShadow` 付与と、影を受ける平面の生成 |

影は**陰影用とは別の専用光源**が落とす（`world.shadowLight`）。陰影用の光源 (1,1,1)
をそのまま使うと仰角 35 度で影が横に長く伸び、接地感が出ないため、専用光源は
ほぼ真上（仰角 約72 度）に置いてある。

専用光源は `intensity: 0` なので明るさには寄与しない。`ShadowMaterial` の影は
`getShadowMask()` で求まり光源の intensity を掛けないため、これで影だけを落とせる。
向きを変えたい場合は `three-world-element.js` の `SHADOW_LIGHT_DIRECTION` を調整する。

## 画面が隠れているときの動き

ブラウザは、見えていないページ（背面のタブ、最小化したウィンドウ、ほかのウィンドウに
完全に覆われたウィンドウ）では `requestAnimationFrame` を止める。そのままだと
会話の途中でアバターの動きの時間も止まってしまうので、`three-world-element.js` は、
見えていない間は描画を省き、`setTimeout` で動きの時間だけを進める。

ただし、ブラウザが隠れたページのタイマーを間引くため、モーションやジェスチャーの
「終わるまで待つ」が最大 1 秒ほど遅れる。5 分以上隠れたままだと、1 分ほど遅れる
ことがある。利用者向けの対処は [README](../README.md#オンライン会議画面共有で使うには) を参照。

## マイクの開き方（音量表示）

マイクのボタンの音量表示は、音声認識（Web Speech API）とは別に、音量を測るためだけの
マイクを開いている。`public/js/speech-recognizer/volume-meter.js` の `KEEP_MIC_OPEN`
で、聞き終えた後の扱いを選べる。

| 値 | 動き |
|---|---|
| `false`（既定） | 聞き終えるたびに閉じる。聞いていない間はマイクを使わないので、会議のアプリなどとマイクを取り合わない。そのぶん音量の表示がわずかに遅れ、Bluetooth のヘッドセットは聞くたびに通話用と音楽用を行き来する（切り替えの間、音が途切れることがある） |
| `true` | 開いたまま。2 回目からはマイクを開き直さないので、音量がすぐ表示される。ただし録音中の表示が消えず、Bluetooth のヘッドセットは通話用の方式（こもった音）のままになる。Google Meet など、ほかのアプリとマイクを取り合って不具合が出ることもある |
