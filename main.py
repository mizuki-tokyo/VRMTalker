"""VRMTalker のアプリケーションサーバ。

    uv run uvicorn main:app --port 8000

localhost は secure context として扱われるため、HTTP のままでもマイク入力
(getUserMedia) と音声認識 (Web Speech API) が利用できる。
外部公開する場合は nginx 等のリバースプロキシで HTTPS を終端すること
（詳細は README.md を参照）。
"""
from __future__ import annotations

import json
import logging
import os
import pathlib
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
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

#: アバターのアクション定義。編集画面から書き戻す
ACTIONS_PATH = PUBLIC_DIR / "actions.json"

#: 書き換えを許すか。ACTIONS_EDITABLE=0 で読み取り専用になる。
#: このアプリをリバースプロキシ等で外部へ公開する場合は必ず 0 にすること。
#: そうしないと、アクセスできる人が誰でもアバターの動作を書き換えられる
ACTIONS_EDITABLE = os.environ.get("ACTIONS_EDITABLE", "1") != "0"


@app.post("/api/actions")
async def post_actions(program: dict) -> dict:
    """アクション定義を保存する。

    書き込み先は public/actions.json の固定で、パスは受け取らない。
    ディレクトリごとコピーすれば、アクションも一緒に運ばれる。
    """
    if not ACTIONS_EDITABLE:
        raise HTTPException(
            status_code=403,
            detail="アクションの保存は無効になっています（ACTIONS_EDITABLE=0）。",
        )
    if "blocks" not in program:
        raise HTTPException(
            status_code=400, detail="Blockly の形式ではありません（blocks がありません）。"
        )

    try:
        ACTIONS_PATH.write_text(
            json.dumps(program, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except OSError as error:
        logger.warning("アクションを保存できませんでした: %s", error)
        raise HTTPException(status_code=500, detail="アクションを保存できませんでした。")

    return {"saved": True}


@app.get("/api/status")
async def get_status():
    """各機能が使える状態かを返す。画面側のエラー表示に使う。"""
    return {
        "tts": text_to_speech.ready,
        "llm": chat_model.name if chat_model is not None else None,
        "llama_server": llama.running,
        "actions_editable": ACTIONS_EDITABLE,
    }


# 静的ファイルの配信は最後にマウントする（/api/* を先に解決させるため）
app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="public")
