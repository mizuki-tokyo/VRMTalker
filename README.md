# VRMTalker

VRM 3D モデルを使った音声対話のテンプレートプロジェクト。

音声認識（Web Speech API）→ 応答生成（LLM）→ 音声合成（VOICEVOX CORE）→ VRM モデルの
リップシンクまでを、ローカル実行のみで動かせる構成になっている。

- 応答生成は **llama.cpp** をローカルで実行する（ビルド不要。サーバ側 LLM にも切替可）
- 音声合成は **VOICEVOX CORE** をローカルで実行する（インストーラ不要）
- Mac / Windows / Linux で動作する
- サーバは Python + FastAPI、フロントは素の Web Components

## 必要なもの

- Python 3.10 以上
- [uv](https://docs.astral.sh/uv/)
- Google Chrome（音声認識に Web Speech API を使用）

同梱の llama.cpp は、どの環境でも **CPU 版**を取得する。GPU 版
（CUDA / Vulkan / ROCm / SYCL）は、どれが使えるかを自動で決められないため
選んでいない。使いたい場合は
[リリースページ](https://github.com/ggml-org/llama.cpp/releases)から対応する
ものを取って `llama/bin` を置き換えること。

| 環境 | 取得するもの |
|---|---|
| macOS | `llama-<版>-bin-macos-arm64 / x64.tar.gz` |
| Windows | `llama-<版>-bin-win-cpu-arm64 / x64.zip` |
| Linux | `llama-<版>-bin-ubuntu-arm64 / x64.tar.gz` |

Linux 向けは Ubuntu でビルドされたものが配られている。ほかの
ディストリビューションでも動くことが多いが、glibc が古い環境では動かない
ことがある。

## セットアップ

```bash
uv sync
```

```bash
uv run python scripts/setup_voicevox.py
```

```bash
uv run python scripts/setup_llama.py
```

`setup_voicevox.py` は VOICEVOX の実行に必要なファイル一式（約 175MB）を
`voicevox_core/` に取得する。実行時に利用規約への同意を求められるので、
内容を確認して判断すること。

`setup_llama.py` は llama.cpp の事前ビルド済みバイナリ（約 10MB）と
GGUF モデル（LFM2.5-2.6B Q4_K_M、約 1.5GB）を `llama/` に取得する。

## 起動

```bash
uv run uvicorn main:app --port 8000
```

http://localhost:8000 を Chrome で開く。マイクのアイコンを押すと音声認識が始まり、
認識結果が音声合成されてモデルが喋る。

## 別の環境へ移す

`voicevox_core/` の中身は次のように分かれている。

| ディレクトリ | 内容 | OS 依存 |
|---|---|---|
| `c_api/` | コア本体 | あり |
| `onnxruntime/` | 推論ランタイム | あり |
| `dict/` | Open JTalk 辞書 | なし |
| `models/` | 音声モデル `.vvm` | なし |

別 OS 向けのファイルは、手元の環境から事前に取得できる。

```bash
uv run python scripts/setup_voicevox.py --os windows --cpu-arch x64
```

`.venv/` はプラットフォーム別のため environment 間でコピーできない。
移行先で `uv sync` を実行すること。

## LLM の切り替え

LLM へのアクセスは `src/llm/base.py` の `ChatModel` で抽象化してある。
利用側（`main.py`）は具体的な実装を知らない。

| 実装 | 用途 |
|---|---|
| `OpenAICompatChat` | 同梱の llama-server（ローカル）、および OpenAI / vLLM / Ollama などサーバ側 LLM |
| `EchoChat` | LLM 無しで動かすためのダミー。復唱するだけ |

環境変数で切り替える。

| 変数 | 既定 | 内容 |
|---|---|---|
| `LLM_BACKEND` | `local` | `local` / `remote` / `echo` |
| `LLM_BASE_URL` | – | `remote` のときのエンドポイント |
| `LLM_MODEL` | `local-model` | モデル名 |
| `LLM_API_KEY` | – | `remote` のときの API キー |
| `LLM_SYSTEM_PROMPT` | （`src/llm/__init__.py` を参照） | システムプロンプト |

サーバ側の LLM を使う例。

```bash
LLM_BACKEND=remote \
LLM_BASE_URL=https://api.openai.com/v1 \
LLM_MODEL=gpt-4o-mini \
LLM_API_KEY=sk-... \
uv run uvicorn main:app --port 8000
```

`local` のときだけ、同梱の llama-server を子プロセスとして自動起動する。

### 応答が遅い場合

`llama/models/` の GGUF を差し替えれば別のモデルを使える。ファイルは 1 つだけ置くこと。

```bash
uv run python scripts/setup_llama.py --model-repo <HFリポジトリ> --model-file <ファイル名>
```

**推論（thinking）モデルには注意**。本文の前に思考トークンを数秒ぶん出力するため、
最初の発話までの待ち時間が大きくなる。既定では `--reasoning-budget 0` で無効化している
（LFM2.5 での実測: 有効だと最初のトークンまで 5〜14 秒、無効なら 0.3〜0.5 秒）。
思考を使いたい場合は `LLAMA_REASONING_BUDGET=-1` を指定する。

同梱の llama-server は既定で `127.0.0.1:8080` を使う。**8080 が他のもので
埋まっている環境では `LLAMA_PORT` で変える**（アプリが繋ぎに行く先も一緒に
変わるので、指定はこれ 1 つで足りる）。

```bash
LLAMA_PORT=8099 ./start.sh
```

その他の調整用の環境変数は `LLAMA_CTX_SIZE` / `LLAMA_THREADS` / `LLAMA_HOST`。

## 設定

### 話者を変える

利用可能な一覧は起動後に http://localhost:8000/api/speakers で確認できる。
既定の `0.vvm` には四国めたん・ずんだもん・春日部つむぎ・雨晴はうの計 10 スタイルが入っている。

変更する箇所は [public/js/speech-synthesizer.js](public/js/speech-synthesizer.js) の `_styleId`。

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

### 音声モデルを追加する

```bash
uv run python scripts/setup_voicevox.py --models-pattern "*"
```

## 素材を入れ替える

アバターの動き・アイコン・音・背景・声は、それぞれ定義ファイル（JSON）で
「何が使えるか」を決める。ブロックのドロップダウンに並ぶのもこの中身なので、
**ファイルを置いて JSON に 1 行足せば、その場で選べるようになる**。

| 種類 | 定義ファイル | 置き場所 |
|---|---|---|
| モーション | `public/animations/motions.json` | `animations/vrma/` `animations/fbx/` |
| エモート（頭の上のアイコン） | `public/emotes/emotes.json` | `public/emotes/` |
| 効果音 | `public/sounds/sounds.json` | `public/sounds/` |
| ボイスデータ | `public/voices/voices.json` | `public/voices/` |
| 背景 | `public/img/backgrounds.json` | `public/img/` |

どれも同じ形をしている。

```json
[
    { "id": "applause", "name": "拍手", "file": "./sounds/applause.mp3" }
]
```

| 項目 | 内容 |
|---|---|
| `id` | アクションが覚える名札。**後から変えないこと**（保存済みのアクションの選択が外れる） |
| `name` | 画面に出す文字。こちらは後から変えてよい |
| `file` | ファイルの場所。`public/` から見た相対パス |

`id` は半角英数とハイフンで付けておくと扱いやすい（ファイル名に合わせるのが楽）。

種類ごとの違いは次のとおり。

- **モーション**は、どれか 1 つに `"default": true` を付ける。それが待機中の
  動きになる。ここに書いたものは起動時にすべて読み込むので、使うものだけを載せる
- **ボイスデータ**はアバターの発話として鳴る。口が動き、「話すのをやめる」で止まる
- **効果音**は場面の音。口は動かず、重ねて鳴らせる
- **背景**は切り替えるときに 0.6 秒かけて溶け込む。最初に出す絵は
  `index.html` の `#screen` が決める

素材の出典は `public/acknowledgment.md` に書く。メニューの「リソースの出典」に
そのまま出るので、差し替えたらここも直すこと。

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

## アクションの公開

アクション（アバターの動き方）は編集画面で組み立てる。誰でも編集でき、
作ったものは手元のファイルとして保存できる。**サーバへ公開できるのは、
合言葉を知っている人だけ**。

| 変数 | 既定 | 内容 |
|---|---|---|
| `ACTIONS_PUBLISH_PASSWORD` | （未設定） | 公開に必要な合言葉。未設定なら公開そのものを断る |

```bash
ACTIONS_PUBLISH_PASSWORD='ここに合言葉' uv run uvicorn main:app --port 8000
```

`.env` に書いておく場合は `uv run --env-file .env uvicorn main:app --port 8000`。

置き場所は次のとおり。

```
public/actions.json   同梱の見本。書き換えない（一覧では「はじめからあるもの」）
data/<UUID>.json      公開されたもの。ファイル名はサーバが採番する
```

`data/` は `public/` の外にあるので静的配信されず、取得は必ず API を通る。
中身は配布物に含めない（`data/.gitignore` で除外している）。**消すときは
サーバで `rm` する**。画面からは消せない。

一覧は、その都度 `data/` を走査して組み立てる。索引ファイルは持たない。
実体とずれる余地を作らないためで、数十件なら走査は一瞬。

**合言葉だけの簡単な仕組み**なので、次の点を承知して使うこと。

- 誰が公開したかは自己申告（作者名は詐称できる）。公開できる人を絞ることで担保している
- 同じアクションを 2 人が直して上書きすると、後に押したほうの内容になる
- 平文 HTTP では合言葉が覗ける。外部へ出すときは下記の HTTPS が必須
- 総当たりへの手当ては「間違えたら 1 秒待たせる」だけ。本格的に守るならプロキシ側で

利用者を管理したい場合や、もっと厳密に扱いたい場合は、ソースを改修して使うこと。

## 外部公開する場合

このアプリは HTTP で待ち受ける。`localhost` / `127.0.0.1` は仕様上
「潜在的に信頼できるオリジン」として扱われるため、HTTP のままでも
マイク入力と音声認識が動作する。

外部からアクセスさせる場合は、**リバースプロキシで HTTPS を終端すること**。
平文 HTTP で LAN の IP 等にアクセスすると secure context にならず、
`navigator.mediaDevices` が生えずマイクが使えない。

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # 応答をストリーミングする場合（SSE / WebSocket）に必要
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

uvicorn 側はプロキシ経由のスキームとクライアント IP を認識できるよう、
次のオプションを付けて起動する。

```bash
uv run uvicorn main:app --host 127.0.0.1 --port 8000 \
    --proxy-headers --forwarded-allow-ips=127.0.0.1
```

`/api/tts` は認証なしで誰でも呼び出せる。公開する場合は nginx の Basic 認証や
FastAPI 側でのトークン検証を検討すること。

## クレジット表記について

VOICEVOX の利用規約により、生成した音声を利用する際は **VOICEVOX を利用したことが
わかるクレジット表記が必要**。使用したキャラクターごとの表記も求められる。

> VOICEVOX:四国めたん

画面右下に表示している（[public/index.html](public/index.html) の `#credit`）。
話者を変更した場合は表示も追従する。

各音声ライブラリの規約は
[VOICEVOX 公式サイト](https://voicevox.hiroshiba.jp/) および
`voicevox_core/models/TERMS.txt` を参照すること。

## ライセンス

- VOICEVOX CORE 0.16 以降のビルド済みコアライブラリ: MIT License
  （0.16 未満は別ライセンスなので注意）
- 音声モデル・音声ライブラリ: 上記「クレジット表記について」を参照

## 構成

アプリケーションのソースは `src/` にまとめ、ルートには利用者が直接実行するもの
（エントリポイントの `main.py` とセットアップスクリプト）だけを置いている。

`src/` はパッケージルートとして venv に入る（`pyproject.toml` の
`[tool.hatch.build.targets.wheel]` を参照）ため、`main.py` からは
`import tts` / `from llm import ...` のように書ける。

```
main.py                     FastAPI アプリ（エントリポイント）
scripts/
  setup_voicevox.py         VOICEVOX 一式の取得
  setup_llama.py            llama.cpp と GGUF モデルの取得
src/
  project_paths.py          プロジェクトルートの解決
  tts.py                    VOICEVOX CORE のラッパー
  llama_server.py           同梱 llama-server の起動・停止
  llm/
    base.py                 ChatModel（抽象基底）と Message
    openai_compat.py        OpenAI 互換 API の実装
    echo.py                 LLM 無しで動かすダミー実装
    __init__.py             環境変数から実装を組み立てる
data/                       公開されたアクション（配布物には含めない）
public/
  index.html
  actions.json              同梱のアクション（読み取り専用の見本）
  acknowledgment.md         素材とソフトウェアの出典
  animations/  emotes/  sounds/  voices/  img/  models/   素材と、その定義ファイル
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
    app-motions.js          motions.json の読み込み
    sound-player.js         効果音
    voices.js               ボイスデータの一覧
    background.js           背景の切り替え
    app-settings.js         設定ウインドウの中身
    app-credits.js          謝辞（出典とモデル情報）
    speech-synthesizer.js   /api/tts のクライアント
    chat-client.js          /api/chat のクライアント（文単位で返す）
    split-sentence.js       文の分割
    three-ui/               3D まわりのカスタム要素
      three-world-element.js  <three-world>  three.js の描画環境
      vrm-avatar-element.js   <vrm-avatar>   VRM モデルの配置と制御
      vrm-avatar-element/     VRM 固有の処理（ローダ、モーション、リップシンク）
      vrm-emote-element.js    <vrm-emote>    頭の上のアイコン
    web-ui/                 画面部品のカスタム要素（吹き出し・設定・ダイアログ等）
```
