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
)

#: 感情の推定。返答の気持ちを、決まった絵文字 1 つで表してもらう。
#: 画面側はこの絵文字を読み取って、ブロックの条件や吹き出しの表示に使う。
#:
#: - 返答の「最初」に付けてもらう。返答は文ごとに読み上げるので、最初に
#:   分かれば話し始める前に表情を変えられる。最後に付けると、絵文字が次の
#:   文の頭や、それだけの 1 文として切り出されてしまう
#: - 絵文字の種類と意味を並べ、ほかの絵文字を使わないよう明記する。小さな
#:   モデル（同梱の LFM2.5-2.6B）は、言わないと 😊 や 🎉 をあちこちに付ける
#: - どれにも当てはまらないときは付けない（無理に選ばせると 😄 に偏る）
#:
#: それでも小さなモデルは、ほかの絵文字を付けたり、似た絵文字（😊 など）を
#: 選んだりすることがある。画面側で、似た絵文字を 5 つのどれかに寄せて読む
EMOTION_ESTIMATION = (
    "返答の最初に、そのときのあなたの気持ちを表す絵文字を 1 つだけ付けてください。"
    "使える絵文字は次の 5 つです。"
    "😄 うれしい・楽しい、😠 怒っている・不満、😢 悲しい・さびしい、😮 驚いた、"
    "😌 落ち着いている・ほっとした。"
    "どれにも当てはまらないときは付けません。"
    "絵文字は読み上げられないので、この 1 つのほかには、文の途中や最後を含めて"
    "絵文字を使わないでください。"
    "例: 😢 それはさびしいね。"
)

#: 会話の例。システムプロンプトの後、実際の履歴の前に置く。
#: 指示を文章で書くより、やりとりの形で見せるほうが、小さなモデルは形式を
#: 真似しやすい（同梱モデルでの試験で、絵文字がちょうど 1 つの返答が
#: 24 回中 7 回から 14 回に増え、最後に付ける返答が無くなった）。
#: 2 つ目は、気持ちが特に無いときは付けない例
EMOTION_EXAMPLES: list[Message] = [
    Message(role="user", content="テストで満点を取ったよ"),
    Message(role="assistant", content="😄 すごいね！がんばったかいがあったね。"),
    Message(role="user", content="今日の天気はどう？"),
    Message(role="assistant", content="ごめんね、天気はわからないんだ。窓の外を見てみてね。"),
]


def system_prompt(name: str = "", profile: str = "") -> str:
    """システムプロンプトを組み立てる。

    :param name:    キャラクタの名前。空なら名乗らせない
    :param profile: 性格や職業などの自由記述。空なら既定の人物像を使う
    """
    parts: list[str] = []

    if name:
        parts.append(f"あなたの名前は「{name}」です。")

    parts.append(profile or os.environ.get("LLM_SYSTEM_PROMPT", DEFAULT_PERSONA))

    parts.append(EMOTION_ESTIMATION)

    # 生成の直前に置く。性格の記述が長いほど前半の指示は効きにくくなるため。
    # 感情の指示より後ろにしないと、返答が長くなりやすい（同梱モデルで確認）
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
    "EMOTION_EXAMPLES",
    "ChatModel",
    "ChatModelError",
    "EchoChat",
    "Message",
    "OpenAICompatChat",
    "Role",
    "create_chat_model",
    "system_prompt",
]
