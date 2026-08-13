"""LLM アクセス層。

環境変数で実装を切り替える。

    LLM_BACKEND   local（既定） | remote | echo
    LLM_MODEL     モデル名。remote のとき必須（例: gpt-4o-mini）
    LLM_BASE_URL  remote のときのエンドポイント（例: https://api.openai.com/v1）
    LLM_API_KEY   remote のときの API キー
    LLM_SYSTEM_PROMPT  システムプロンプト

local は同梱の llama-server を起動して使う（llama_server.py を参照）。
remote と local はどちらも OpenAI 互換なので、実装は OpenAICompatChat を共用する。
"""
from __future__ import annotations

import os

from .base import ChatModel, ChatModelError, Message, Role
from .echo import EchoChat
from .openai_compat import OpenAICompatChat

DEFAULT_SYSTEM_PROMPT = (
    "あなたは親しみやすい会話相手です。"
    "返答はそのまま音声で読み上げられます。"
    "記号や箇条書きを使わず、1〜2 文の短い話し言葉で答えてください。"
)


def system_prompt() -> str:
    return os.environ.get("LLM_SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT)


def create_chat_model(local_base_url: str) -> ChatModel:
    """環境変数から ChatModel を組み立てる。

    :param local_base_url: 同梱 llama-server の OpenAI 互換エンドポイント
    """
    backend = os.environ.get("LLM_BACKEND", "local").lower()

    if backend == "echo":
        return EchoChat()

    if backend == "remote":
        base_url = os.environ.get("LLM_BASE_URL")
        if not base_url:
            raise ChatModelError("LLM_BACKEND=remote には LLM_BASE_URL が必要です。")
        return OpenAICompatChat(
            base_url=base_url,
            model=os.environ.get("LLM_MODEL", "gpt-4o-mini"),
            api_key=os.environ.get("LLM_API_KEY"),
        )

    if backend == "local":
        return OpenAICompatChat(
            base_url=local_base_url,
            model=os.environ.get("LLM_MODEL", "local-model"),
        )

    raise ChatModelError(f"未知の LLM_BACKEND です: {backend}")


__all__ = [
    "ChatModel",
    "ChatModelError",
    "EchoChat",
    "Message",
    "OpenAICompatChat",
    "Role",
    "create_chat_model",
    "system_prompt",
]
