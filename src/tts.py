"""VOICEVOX CORE によるローカル音声合成。

VOICEVOX CORE はライブラリであり、GUI アプリや ENGINE のインストールは不要。
必要なファイル一式は scripts/setup_voicevox.py で取得する。

    python scripts/setup_voicevox.py

生成した音声を利用する際は VOICEVOX のクレジット表記が必要。詳しくは README.md を参照。
"""
from __future__ import annotations

import os
import pathlib
import sys
from dataclasses import dataclass

from voicevox_core.asyncio import Onnxruntime, OpenJtalk, Synthesizer, VoiceModelFile

from project_paths import PROJECT_ROOT

# VOICEVOX 一式の配置先。環境変数で差し替えられる
VOICEVOX_DIR = pathlib.Path(
    os.environ.get("VOICEVOX_DIR", PROJECT_ROOT / "voicevox_core")
)

# 既定のスタイル。0.vvm の「四国めたん (ノーマル)」
DEFAULT_STYLE_ID = 2


@dataclass(frozen=True)
class Speaker:
    style_id: int
    character: str
    style: str


class SetupRequiredError(RuntimeError):
    """VOICEVOX のファイル一式が見つからないときに送出する。"""


def _find_onnxruntime() -> pathlib.Path:
    """OS ごとに名前が異なる ONNX Runtime の共有ライブラリを探す。

    macOS  : libvoicevox_onnxruntime.1.17.3.dylib
    Windows: voicevox_onnxruntime.dll
    Linux  : libvoicevox_onnxruntime.so.1.17.3
    """
    lib_dir = VOICEVOX_DIR / "onnxruntime" / "lib"
    suffix = {"darwin": ".dylib", "win32": ".dll"}.get(sys.platform, ".so")

    candidates = [
        path for path in sorted(lib_dir.glob("*voicevox_onnxruntime*"))
        if suffix in path.name
    ]
    if not candidates:
        raise SetupRequiredError(
            f"ONNX Runtime が見つかりません: {lib_dir}\n"
            f"`python scripts/setup_voicevox.py` を実行してください。"
        )
    return candidates[0]


def _find_dict() -> pathlib.Path:
    dict_root = VOICEVOX_DIR / "dict"
    candidates = sorted(dict_root.glob("open_jtalk_dic_utf_8-*"))
    if not candidates:
        raise SetupRequiredError(
            f"Open JTalk 辞書が見つかりません: {dict_root}\n"
            f"`python scripts/setup_voicevox.py` を実行してください。"
        )
    return candidates[0]


def _find_models() -> list[pathlib.Path]:
    models_dir = VOICEVOX_DIR / "models" / "vvms"
    models = sorted(models_dir.glob("*.vvm"))
    if not models:
        raise SetupRequiredError(
            f"音声モデル (.vvm) が見つかりません: {models_dir}\n"
            f"`python scripts/setup_voicevox.py` を実行してください。"
        )
    return models


class TextToSpeech:
    """VOICEVOX CORE のラッパー。

    初期化に約 1 秒かかるため、プロセス起動時に一度だけ行い使い回すこと。
    """

    def __init__(self) -> None:
        self._synthesizer: Synthesizer | None = None

    async def initialize(self) -> None:
        onnxruntime = await Onnxruntime.load_once(filename=str(_find_onnxruntime()))
        open_jtalk = await OpenJtalk.new(str(_find_dict()))
        synthesizer = Synthesizer(onnxruntime, open_jtalk)

        for model_path in _find_models():
            async with await VoiceModelFile.open(str(model_path)) as model:
                await synthesizer.load_voice_model(model)

        self._synthesizer = synthesizer

    @property
    def ready(self) -> bool:
        return self._synthesizer is not None

    def speakers(self) -> list[Speaker]:
        if self._synthesizer is None:
            return []
        return [
            Speaker(style_id=style.id, character=meta.name, style=style.name)
            for meta in self._synthesizer.metas()
            for style in meta.styles
        ]

    async def synthesize(self, text: str, style_id: int = DEFAULT_STYLE_ID) -> bytes:
        """テキストを WAV(24kHz, 16bit, モノラル) のバイト列にする。"""
        if self._synthesizer is None:
            raise SetupRequiredError("音声合成の初期化が完了していません。")
        return await self._synthesizer.tts(text, style_id)
