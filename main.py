"""VRMTalker のアプリケーションサーバ。

    uv run uvicorn main:app --port 8000

localhost は secure context として扱われるため、HTTP のままでもマイク入力
(getUserMedia) と音声認識 (Web Speech API) が利用できる。
外部公開する場合は nginx 等のリバースプロキシで HTTPS を終端すること
（詳細は README.md を参照）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import pathlib
import secrets
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import llama_server
from llm import ChatModel, ChatModelError, Message, create_chat_model, system_prompt
from tts import DEFAULT_STYLE_ID, SetupRequiredError, TextToSpeech

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("vrmtalker")

PUBLIC_DIR = pathlib.Path(__file__).parent / "public"

text_to_speech = TextToSpeech()
llama = llama_server.LlamaServer()
chat_model: ChatModel | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global chat_model

    # 音声合成の初期化には約 1 秒かかるため、起動時に一度だけ行う
    try:
        started = time.perf_counter()
        await text_to_speech.initialize()
        logger.info("VOICEVOX を初期化しました (%.0fms, %d スタイル)",
                    (time.perf_counter() - started) * 1000,
                    len(text_to_speech.speakers()))
    except SetupRequiredError as error:
        # 音声合成が使えなくても画面は表示できるよう、起動自体は継続する
        logger.warning("音声合成を初期化できませんでした: %s", error)

    # LLM。local のときだけ同梱の llama-server を起動する
    backend = os.environ.get("LLM_BACKEND", "local").lower()
    if backend == "local":
        try:
            started = time.perf_counter()
            await llama.start()
            logger.info("llama-server を起動しました (%.1fs)",
                        time.perf_counter() - started)
        except (llama_server.SetupRequiredError, OSError) as error:
            logger.warning("ローカル LLM を起動できませんでした: %s", error)

    try:
        chat_model = create_chat_model(llama_server.base_url())
        logger.info("LLM: %s", chat_model.name)
    except ChatModelError as error:
        logger.warning("LLM を初期化できませんでした: %s", error)

    yield

    if chat_model is not None:
        await chat_model.aclose()
    llama.stop()


app = FastAPI(title="VRMTalker", lifespan=lifespan)


# ---------------------------------------------------------------- 音声合成

class SynthesisRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=1000)
    style_id: int = DEFAULT_STYLE_ID


@app.get("/api/speakers")
async def get_speakers():
    """利用可能なキャラクターとスタイルの一覧。"""
    return [
        {"style_id": s.style_id, "character": s.character, "style": s.style}
        for s in text_to_speech.speakers()
    ]


@app.post("/api/tts")
async def post_tts(request: SynthesisRequest) -> Response:
    """テキストを音声合成して WAV を返す。"""
    if not text_to_speech.ready:
        raise HTTPException(
            status_code=503,
            detail="音声合成が利用できません。`uv run python scripts/setup_voicevox.py` を実行してください。",
        )
    try:
        started = time.perf_counter()
        wav = await text_to_speech.synthesize(request.text, request.style_id)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
    except Exception as error:
        logger.exception("音声合成に失敗しました")
        raise HTTPException(status_code=500, detail=str(error)) from error

    return Response(
        content=wav,
        media_type="audio/wav",
        headers={"X-Synthesis-Ms": str(elapsed_ms)},
    )


# ---------------------------------------------------------------- 対話

class Persona(BaseModel):
    """画面で設定するキャラクタ像。未設定なら既定の人物像が使われる。"""

    name: str = Field("", max_length=50)
    profile: str = Field("", max_length=2000)


class ChatRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    history: list[dict[str, str]] = Field(default_factory=list)
    persona: Persona | None = None


def _build_messages(request: ChatRequest) -> list[Message]:
    persona = request.persona or Persona()
    messages = [
        Message(
            role="system",
            content=system_prompt(name=persona.name, profile=persona.profile),
        )
    ]
    for item in request.history[-10:]:  # 直近のやりとりのみ渡す
        role = item.get("role")
        content = item.get("content")
        if role in ("user", "assistant") and content:
            messages.append(Message(role=role, content=content))
    messages.append(Message(role="user", content=request.text))
    return messages


@app.post("/api/chat")
async def post_chat(request: ChatRequest) -> StreamingResponse:
    """応答文を Server-Sent Events で少しずつ返す。

    文が完成した時点でクライアント側が音声合成に回せるよう、
    生成が終わるのを待たずに差分を流す。
    """
    if chat_model is None:
        raise HTTPException(
            status_code=503,
            detail="LLM が利用できません。`uv run python scripts/setup_llama.py` を実行してください。",
        )

    messages = _build_messages(request)

    async def event_stream() -> AsyncIterator[str]:
        try:
            async for delta in chat_model.stream(messages):
                yield f"data: {json.dumps({'delta': delta}, ensure_ascii=False)}\n\n"
        except ChatModelError as error:
            logger.warning("LLM の呼び出しに失敗しました: %s", error)
            yield f"data: {json.dumps({'error': str(error)}, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # nginx を経由する場合にバッファリングさせない
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------- アクション
#
# アクション（アバターの動き方の定義）は 1 つ 1 ファイル。
#
#   public/actions.json   同梱の見本。書き換えない（読み取り専用で配る）
#   data/<UUID>.json      公開されたもの。パスワードを知っている人だけが増やせる
#
# data/ を public/ の外に置いているのは、静的配信の対象にしないため。
# 取得は必ず下の API を通り、ファイル名も UUID しか受け付けない。
#
# 一覧は、その都度 data/ を走査して組み立てる。索引ファイルを持つと、手で
# ファイルを足したときや公開が途中で失敗したときに実体とずれる。数十件の
# 走査は一瞬なので、ずれる余地を作らないほうを選んだ。

#: 同梱の見本。data/ が空でも、これだけは必ず読める
DEFAULT_ACTIONS_PATH = PUBLIC_DIR / "actions.json"

#: 見本を指す ID。UUID と混ざらない名前にしてある
DEFAULT_ACTION_ID = "default"

#: 公開されたアクションの置き場
DATA_DIR = pathlib.Path(__file__).parent / "data"

#: 公開に必要な合言葉。空（未設定）なら公開そのものを断る。
#: 誰でも書き込めると、アバターに何でも喋らせられるため、既定は「公開できない」
PUBLISH_PASSWORD = os.environ.get("ACTIONS_PUBLISH_PASSWORD", "")

#: 1 件あたりの上限。青天井だとディスクを埋められる
MAX_ACTION_BYTES = 1024 * 1024

#: 合言葉を間違えたときに待たせる秒数。
#: 総当たりを現実的でない速さにするための、いちばん簡単な手当て。
#: 回数で締め出す方式は、嫌がらせで正規の利用者まで閉め出せてしまうので採らない。
#: 本格的に守るなら、前段のリバースプロキシ側で対策すること
FAILED_PASSWORD_DELAY = 1.0


def _action_properties(action: dict) -> dict:
    """アクションに書かれている素性を取り出す。

    中身は自己申告で、正しさは保証しない（公開できる人を絞ることで担保する）。
    欠けていても一覧を組めるよう、無い項目は空文字にする
    """
    properties = action.get("properties")
    if not isinstance(properties, dict):
        properties = {}
    return {
        key: str(properties.get(key, ""))
        for key in ("name", "description", "author", "created")
    }


def _read_action(path: pathlib.Path) -> dict | None:
    """1 ファイル読む。壊れていても例外は投げない（一覧全体を巻き込まない）。"""
    try:
        action = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        logger.warning("アクション %s を読めませんでした: %s", path.name, error)
        return None
    if not isinstance(action, dict) or "blocks" not in action:
        logger.warning("アクション %s は Blockly の形式ではありません", path.name)
        return None
    return action


def _action_path(action_id: str) -> pathlib.Path:
    """ID からファイルの場所を決める。

    UUID として読めない文字列は弾く。これで "../" のような細工が通らない
    （文字を取り除くのではなく、形が合わないものを断る）
    """
    try:
        identifier = uuid.UUID(str(action_id))
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(status_code=400, detail="アクションの ID が不正です。")
    return DATA_DIR / f"{identifier}.json"


@app.get("/api/actions")
async def get_actions() -> dict:
    """公開されているアクションの一覧。中身は返さず、素性だけを返す。"""
    entries = []

    default = _read_action(DEFAULT_ACTIONS_PATH)
    if default is not None:
        properties = _action_properties(default)
        entries.append({
            "id": DEFAULT_ACTION_ID,
            # 名前が書かれていない古い形式でも、選べるように名前を補う
            "name": properties["name"] or "はじめからあるもの",
            "description": properties["description"],
            "author": properties["author"],
            "created": properties["created"],
            # 見本は上書きさせない。いじり倒しても、ここへ戻ってこられる
            "readonly": True,
        })

    # 新しいものから並べる。日時は自己申告なので、当てにせずファイルの更新時刻を見る
    paths = sorted(DATA_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in paths:
        action = _read_action(path)
        if action is None:
            continue
        entries.append({
            "id": path.stem,
            **_action_properties(action),
            "readonly": False,
        })

    return {"actions": entries, "publishable": bool(PUBLISH_PASSWORD)}


@app.get("/api/actions/{action_id}")
async def get_action(action_id: str) -> dict:
    """アクションを 1 つ返す。"""
    if action_id == DEFAULT_ACTION_ID:
        action = _read_action(DEFAULT_ACTIONS_PATH)
    else:
        action = _read_action(_action_path(action_id))

    if action is None:
        raise HTTPException(status_code=404, detail="そのアクションはありません。")
    return action


@app.post("/api/actions")
async def post_action(request: Request) -> dict:
    """アクションを公開する。

    本文は {"password": …, "id": …（上書きするとき）, "action": {…}}。
    ID を渡さなければ新しく採番する。ID はサーバが決める（利用者が決めた名前を
    そのままファイル名にすると、パスを混ぜられる）
    """
    if not PUBLISH_PASSWORD:
        raise HTTPException(
            status_code=403,
            detail="このサーバでは公開できません（ACTIONS_PUBLISH_PASSWORD が未設定）。",
        )

    # 本文の大きさは、JSON として読む前に見る（読んでから気づいては遅い）
    body = await request.body()
    if len(body) > MAX_ACTION_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"アクションが大きすぎます（上限 {MAX_ACTION_BYTES // 1024}KB）。",
        )
    try:
        payload = json.loads(body)
    except ValueError:
        raise HTTPException(status_code=400, detail="JSON として読めません。")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="JSON として読めません。")

    # 合言葉。文字の違いで判定が早く終わらないよう compare_digest を使う。
    # bytes にしてから渡すこと。str のままだと、ASCII 以外を含む合言葉
    # （日本語など）で TypeError になる
    given = str(payload.get("password", "")).encode("utf-8")
    if not secrets.compare_digest(given, PUBLISH_PASSWORD.encode("utf-8")):
        await asyncio.sleep(FAILED_PASSWORD_DELAY)
        raise HTTPException(status_code=403, detail="合言葉が違います。")

    action = payload.get("action")
    if not isinstance(action, dict) or "blocks" not in action:
        raise HTTPException(
            status_code=400, detail="Blockly の形式ではありません（blocks がありません）。"
        )

    action_id = payload.get("id")
    if action_id in (None, ""):
        path = DATA_DIR / f"{uuid.uuid4()}.json"
    elif action_id == DEFAULT_ACTION_ID:
        raise HTTPException(status_code=403, detail="はじめからあるものは上書きできません。")
    else:
        path = _action_path(action_id)
        if not path.exists():
            raise HTTPException(status_code=404, detail="上書きする相手がありません。")

    # 一時ファイルへ書いてから置き換える。途中で落ちても、壊れた JSON が残らない
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".writing")
        temporary.write_text(
            json.dumps(action, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        os.replace(temporary, path)
    except OSError as error:
        logger.warning("アクションを公開できませんでした: %s", error)
        raise HTTPException(status_code=500, detail="アクションを公開できませんでした。")

    logger.info("アクションを公開しました: %s", path.name)
    return {"id": path.stem}


@app.get("/api/status")
async def get_status():
    """各機能が使える状態かを返す。画面側のエラー表示に使う。"""
    return {
        "tts": text_to_speech.ready,
        "llm": chat_model.name if chat_model is not None else None,
        "llama_server": llama.running,
        # 合言葉そのものは返さない。公開の口があるかどうかだけ
        "actions_publishable": bool(PUBLISH_PASSWORD),
    }


class NoCacheStaticFiles(StaticFiles):
    """更新したファイルが必ず画面へ反映されるようにする。

    ブラウザは JS や HTML を強く握る。編集しながら動かすと、直したはずの
    ファイルが古いまま動き続け、原因の分からない不具合として現れる。

    no-cache は「保存はしてよいが、使う前に必ず問い合わせる」の意味。
    StaticFiles が ETag を付けるので、中身が変わっていなければ 304 が返り、
    転送は起きない。毎回読み直させる no-store より軽い。
    """

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


# 静的ファイルの配信は最後にマウントする（/api/* を先に解決させるため）
app.mount("/", NoCacheStaticFiles(directory=str(PUBLIC_DIR), html=True), name="public")
