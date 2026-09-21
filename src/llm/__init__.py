"""LLM アクセス層。

環境変数で実装を切り替える。

    LLM_BACKEND   local（既定） | remote | echo
    LLM_MODEL     モデル名。remote のとき必須（例: gpt-4o-mini）
    LLM_BASE_URL  remote のときのエンドポイント（例: https://api.openai.com/v1）
    LLM_API_KEY   remote のときの API キー
    LLM_SYSTEM_PROMPT  既定の人物像（画面で性格を設定していないときに使う）

local は同梱の llama-server を起動して使う（llama_server.py を参照）。
remote と local はどちらも OpenAI 互換なので、実装は OpenAICompatChat を共用する。
"""
from __future__ import annotations

import os

from .base import ChatModel, ChatModelError, Message, Role
from .echo import EchoChat
from .openai_compat import OpenAICompatChat

#: 画面で性格を設定していないときの人物像。利用者の設定で置き換わる
DEFAULT_PERSONA = "あなたは親しみやすい会話相手です。"

#: 音声で読み上げるための制約。人物像と違い、利用者の設定では置き換えない。
#: 応答は文ごとに区切って音声合成へ渡すため、箇条書きや記号が混ざると
#: 読み上げが破綻し、長文だと最初の発話までの待ち時間も伸びる
SPEECH_STYLE_RULES = (
    "返答はそのまま音声で読み上げられます。"
    "記号や箇条書きを使わず、1〜2 文の短い話し言葉で答えてください。"
    "絵文字は読み上げられません。"
)

# EMOTION_ESTIMATION = '''
# 絵文字を使用する場合は、必ず以下の５種類から１つを選んで応答の最後に加るようにしてください。
# 🙂:通常、
# 😄:喜びを感じている、
# 😠:怒りを感じている、
# 😭:悲しみを感じている、
# 😌:安らぎを感じている、
# '''

def system_prompt(name: str = "", profile: str = "") -> str:
    """システムプロンプトを組み立てる。

    :param name:    キャラクタの名前。空なら名乗らせない
    :param profile: 性格や職業などの自由記述。空なら既定の人物像を使う
    """
    parts: list[str] = []

    if name:
        parts.append(f"あなたの名前は「{name}」です。")

    parts.append(profile or os.environ.get("LLM_SYSTEM_PROMPT", DEFAULT_PERSONA))

    #parts.append(EMOTION_ESTIMATION)

    # 生成の直前に置く。性格の記述が長いほど前半の指示は効きにくくなるため
    parts.append(SPEECH_STYLE_RULES)

    return "\n".join(parts)


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
