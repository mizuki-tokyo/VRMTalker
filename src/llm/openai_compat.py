"""OpenAI 互換 API を叩く ChatModel 実装。

同梱の llama-server（ローカル）も、OpenAI / vLLM / Ollama などのサーバ側 LLM も
すべてこの実装で扱える。違いは base_url と api_key だけ。

相手が一時的に応えられないとき（混雑の 503 や、回数制限の 429 など）は、
少し待ってやり直す。無料枠のクラウド LLM では珍しくなく、1 回で諦めると
会話が「エラーが起きました」で途切れてしまうため。
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
from collections.abc import AsyncIterator

import httpx

from .base import ChatModel, ChatModelError, Message

logger = logging.getLogger("vrmtalker.llm")

#: やり直してよい状態コード。どれも「待てば通るかもしれない」もの。
#: 404（モデルが無い）や 401（キーが違う）は、何度やっても同じなので含めない
RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})

#: 最初の 1 回を含めた試行の回数
MAX_ATTEMPTS = 3

#: やり直す前に待つ秒数の基準。1 回目の失敗で 1 秒、2 回目で 2 秒…と伸ばす。
#: 混んでいる相手に間を置かずに叩き直すと、かえって混雑を長引かせる
BACKOFF_SECONDS = 1.0

#: 相手が Retry-After で「これだけ待て」と言ってきたときの上限。
#: 音声対話なので、長く待たせるくらいなら諦めて知らせたほうがよい
MAX_RETRY_AFTER = 10.0


def _retry_delay(attempt: int, response: httpx.Response | None) -> float:
    """次に試すまで待つ秒数。

    相手の指定（Retry-After）があればそれに従い、無ければ倍々に伸ばす。
    少しだけ揺らす（jitter）のは、複数の利用者が同じ時刻にやり直して
    また一斉にぶつかるのを避けるため
    """
    if response is not None:
        retry_after = response.headers.get("Retry-After")
        try:
            if retry_after is not None:
                return min(float(retry_after), MAX_RETRY_AFTER)
        except ValueError:
            pass  # 日付で来た場合などは、下の既定に任せる
    return BACKOFF_SECONDS * (2 ** (attempt - 1)) + random.uniform(0, 0.5)


def _describe_error(response: httpx.Response, body: bytes) -> str:
    """状態コードに、相手が書いてきた理由を添える。

    状態コードと URL だけでは、何が悪いのか分からない（モデルが使えない
    のに URL を疑ってしまう、など）。本当の理由は本文に書かれている
    """
    reason = ""
    try:
        data = json.loads(body)
        # Gemini は、エラーを配列で包んで返すことがある
        if isinstance(data, list) and data:
            data = data[0]
        reason = str(data.get("error", {}).get("message", "")).strip()
    except (ValueError, AttributeError):
        reason = body[:200].decode("utf-8", errors="replace").strip()

    text = f"LLM がエラーを返しました（{response.status_code}）"
    return f"{text}: {reason}" if reason else text


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

    async def _wait_before_retry(
        self, attempt: int, reason: str, response: httpx.Response | None = None
    ) -> None:
        delay = _retry_delay(attempt, response)
        logger.warning("%s → %.1f 秒待ってやり直します（%d/%d 回目）",
                       reason, delay, attempt, MAX_ATTEMPTS - 1)
        await asyncio.sleep(delay)

    async def generate(self, messages: list[Message]) -> str:
        url = f"{self._base_url}/chat/completions"
        payload = self._payload(messages, stream=False)

        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                response = await self._client.post(url, json=payload)
            except httpx.TransportError as error:
                if attempt < MAX_ATTEMPTS:
                    await self._wait_before_retry(attempt, f"LLM に繋がりませんでした（{error}）")
                    continue
                raise ChatModelError(f"LLM への接続に失敗しました: {error}") from error

            if response.status_code >= 400:
                message = _describe_error(response, response.content)
                if response.status_code in RETRY_STATUSES and attempt < MAX_ATTEMPTS:
                    await self._wait_before_retry(attempt, message, response)
                    continue
                raise ChatModelError(message)

            body = response.json()
            try:
                return body["choices"][0]["message"]["content"]
            except (KeyError, IndexError) as error:
                raise ChatModelError(f"LLM の応答を解釈できませんでした: {body}") from error

        raise ChatModelError("LLM への接続に失敗しました")  # ここへは来ない

    async def stream(self, messages: list[Message]) -> AsyncIterator[str]:
        """応答を少しずつ返す。

        やり直すのは、まだ 1 文字も返していないときだけ。途中まで返した後に
        やり直すと、同じ文を頭から二度喋ることになるため。状態コードは本文より
        先に届くので、混雑（503）などは必ず「まだ何も返していない」うちに分かる
        """
        url = f"{self._base_url}/chat/completions"
        payload = self._payload(messages, stream=True)

        for attempt in range(1, MAX_ATTEMPTS + 1):
            started = False
            try:
                async with self._client.stream("POST", url, json=payload) as response:
                    if response.status_code >= 400:
                        # 理由は本文にある。ストリームでは読むまで手元に無い
                        message = _describe_error(response, await response.aread())
                        if response.status_code in RETRY_STATUSES and attempt < MAX_ATTEMPTS:
                            await self._wait_before_retry(attempt, message, response)
                            continue
                        raise ChatModelError(message)

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
                            started = True
                            yield delta
                    return

            except httpx.TransportError as error:
                # 繋がらない・途中で切れた。まだ何も返していなければやり直せる
                if not started and attempt < MAX_ATTEMPTS:
                    await self._wait_before_retry(attempt, f"LLM に繋がりませんでした（{error}）")
                    continue
                raise ChatModelError(f"LLM への接続に失敗しました: {error}") from error

    async def aclose(self) -> None:
        await self._client.aclose()
