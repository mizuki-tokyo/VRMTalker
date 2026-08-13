"""LLM へのアクセスを抽象化する。

ローカル LLM とサーバ上の LLM を同じインタフェースで扱えるようにするための層。
利用側（main.py）は具体的な実装を知らずに ChatModel だけに依存する。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Literal

Role = Literal["system", "user", "assistant"]


@dataclass(frozen=True)
class Message:
    role: Role
    content: str

    def to_dict(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


class ChatModelError(RuntimeError):
    """LLM へのアクセスに失敗したときに送出する。"""


class ChatModel(ABC):
    """対話モデルのインタフェース。"""

    @property
    @abstractmethod
    def name(self) -> str:
        """実装を識別するための名前。ログや /api/status に使う。"""

    @abstractmethod
    async def generate(self, messages: list[Message]) -> str:
        """応答文を一括で生成する。"""

    @abstractmethod
    def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        """応答文を差分（トークン）で順に返す。

        音声対話では、文が完成した時点で順次音声合成へ回すことで
        最初の発話までの待ち時間を短くできる。
        """

    async def aclose(self) -> None:
        """後始末が必要な実装はここで行う。"""
