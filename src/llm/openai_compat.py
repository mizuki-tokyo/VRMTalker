"""OpenAI 互換 API を叩く ChatModel 実装。

同梱の llama-server（ローカル）も、OpenAI / vLLM / Ollama などのサーバ側 LLM も
すべてこの実装で扱える。違いは base_url と api_key だけ。
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx

from .base import ChatModel, ChatModelError, Message


class OpenAICompatChat(ChatModel):

    def __init__(
        self,
        base_url: str,
        model: str = "local-model",
        api_key: str | None = None,
        *,
        temperature: float = 0.7,
        max_tokens: int = 512,
        timeout: float = 120.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._temperature = temperature
        self._max_tokens = max_tokens

        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._client = httpx.AsyncClient(headers=headers, timeout=timeout)

    @property
    def name(self) -> str:
        return f"openai-compat({self._base_url}, {self._model})"

    def _payload(self, messages: list[Message], stream: bool) -> dict:
        return {
            "model": self._model,
            "messages": [m.to_dict() for m in messages],
            "temperature": self._temperature,
            "max_tokens": self._max_tokens,
            "stream": stream,
        }

    async def generate(self, messages: list[Message]) -> str:
        try:
            response = await self._client.post(
                f"{self._base_url}/chat/completions",
                json=self._payload(messages, stream=False),
            )
            response.raise_for_status()
            body = response.json()
        except httpx.HTTPError as error:
            raise ChatModelError(f"LLM への接続に失敗しました: {error}") from error

        try:
            return body["choices"][0]["message"]["content"]
        except (KeyError, IndexError) as error:
            raise ChatModelError(f"LLM の応答を解釈できませんでした: {body}") from error

    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        try:
            async with self._client.stream(
                "POST",
                f"{self._base_url}/chat/completions",
                json=self._payload(messages, stream=True),
            ) as response:
                response.raise_for_status()

                async for line in response.aiter_lines():
                    # SSE 形式: "data: {...}" と、終端の "data: [DONE]"
                    if not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if data == "[DONE]":
                        break

                    try:
                        chunk = json.loads(data)
                        delta = chunk["choices"][0]["delta"].get("content")
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue  # usage 情報など content を含まないチャンクは読み飛ばす

                    if delta:
                        yield delta

        except httpx.HTTPError as error:
            raise ChatModelError(f"LLM への接続に失敗しました: {error}") from error

    async def aclose(self) -> None:
        await self._client.aclose()
