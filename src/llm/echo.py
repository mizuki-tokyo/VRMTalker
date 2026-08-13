"""LLM を用意せずに動作確認するためのダミー実装。

モデルのダウンロードなしにアプリ全体（音声認識 → 応答 → 音声合成 → リップシンク）
を通しで試せるようにしておく。テンプレートプロジェクトとしての最低動作保証も兼ねる。
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from .base import ChatModel, Message


class EchoChat(ChatModel):

    def __init__(self, *, delay: float = 0.02) -> None:
        # ストリーミングの見え方を実際の LLM に近づけるための擬似的な遅延
        self._delay = delay

    @property
    def name(self) -> str:
        return "echo"

    def _reply(self, messages: list[Message]) -> str:
        last_user = next(
            (m.content for m in reversed(messages) if m.role == "user"), ""
        )
        return f"{last_user}、と聞こえました。"

    async def generate(self, messages: list[Message]) -> str:
        return self._reply(messages)

    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        for character in self._reply(messages):
            await asyncio.sleep(self._delay)
            yield character
