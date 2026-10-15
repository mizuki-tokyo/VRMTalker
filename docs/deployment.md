# サーバーとして公開する

VRMTalker をほかの人にも使ってもらうための設定をまとめる。プログラマでなくても
進められるよう、手順と注意点を中心に書いてある。
使い方は [README](../README.md)、中の作りは [development.md](development.md) を参照。

## 設定は `.env` に書く

合言葉や API キーなどの設定は、`.env.example` を `.env` という名前で写して
書き換える。`./start.sh` で起動すると、`.env` の中身が読み込まれる。

```bash
cp .env.example .env
```

`.env` は Git に入らない（`.gitignore` で除外している）。合言葉や API キーを
書いたファイルを、人に渡したり公開したりしないこと。

`start.sh` を使わずに起動する場合は、`--env-file` で読み込ませる。

```bash
uv run --env-file .env uvicorn main:app --port 8000
```

## アクションの公開

アクション（アバターの動き方）は編集画面で組み立てる。誰でも編集でき、
作ったものは手元のファイルとして保存できる。**サーバーへ公開できるのは、
合言葉を知っている人だけ**。

| 変数 | 既定 | 内容 |
|---|---|---|
| `ACTIONS_PUBLISH_PASSWORD` | （未設定） | 公開に必要な合言葉。未設定なら公開そのものを断る |

`.env` に書くか、起動するときに指定する。

```bash
ACTIONS_PUBLISH_PASSWORD='ここに合言葉' uv run uvicorn main:app --port 8000
```

### 置き場所

```
public/actions.json   同梱の見本。書き換えない（一覧では「はじめからあるもの」）
data/<UUID>.json      公開されたもの。ファイル名はサーバーが採番する
```

`data/` は `public/` の外にあるので静的配信されず、取得は必ず API を通る。
中身は配布物に含めない（`data/.gitignore` で除外している）。**消すときは
サーバーで `rm` する**。画面からは消せない。

一覧は、その都度 `data/` を走査して組み立てる。索引ファイルは持たない。
実体とずれる余地を作らないためで、数十件なら走査は一瞬。

### 注意点

**合言葉だけの簡単な仕組み**なので、次の点を承知して使うこと。

- 誰が公開したかは自己申告（作者名は詐称できる）。公開できる人を絞ることで担保している
- 同じアクションを 2 人が直して上書きすると、後に押したほうの内容になる
- 平文 HTTP では合言葉が覗ける。外部へ出すときは下記の HTTPS が必須
- 総当たりへの手当ては「間違えたら 1 秒待たせる」だけ。本格的に守るならプロキシ側で

利用者を管理したい場合や、もっと厳密に扱いたい場合は、ソースを改修して使うこと。

## 外部に公開する（HTTPS）

このアプリは HTTP で待ち受ける。`localhost` / `127.0.0.1` は仕様上
「潜在的に信頼できるオリジン」として扱われるため、HTTP のままでも
マイク入力と音声認識が動作する。

外部からアクセスさせる場合は、**リバースプロキシで HTTPS を終端すること**。
平文 HTTP で LAN の IP 等にアクセスすると secure context にならず、
`navigator.mediaDevices` が生えずマイクが使えない。

nginx の例は次のとおり。

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

### 誰でも呼び出せる API に注意する

`/api/tts`（音声合成）と `/api/chat`（返事の生成）は、認証なしで誰でも呼び出せる。
サーバー側の LLM（`LLM_BACKEND=remote`）を使っていると、呼び出されるたびに
API の利用料がかかる。公開する場合は、nginx の Basic 認証や、FastAPI 側での
トークン検証を検討すること。
