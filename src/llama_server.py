"""同梱した llama.cpp の llama-server を子プロセスとして管理する。

llama.cpp は事前ビルド済みバイナリを配布しているため、ソースビルドは不要。
（llama-cpp-python は PyPI に sdist しか無く、CMake と C++ ツールチェーンが要る）

必要なファイルは scripts/setup_llama.py で取得する。
"""
from __future__ import annotations

import asyncio
import logging
import os
import pathlib
import subprocess
import sys

import httpx

from project_paths import PROJECT_ROOT

logger = logging.getLogger("vrmtalker.llama")

LLAMA_DIR = pathlib.Path(
    os.environ.get("LLAMA_DIR", PROJECT_ROOT / "llama")
)
HOST = os.environ.get("LLAMA_HOST", "127.0.0.1")
PORT = int(os.environ.get("LLAMA_PORT", "8080"))

# 起動待ちの上限。初回はモデルの読み込みに時間がかかる
STARTUP_TIMEOUT = float(os.environ.get("LLAMA_STARTUP_TIMEOUT", "120"))


class SetupRequiredError(RuntimeError):
    """llama-server や GGUF モデルが見つからないときに送出する。"""


def base_url() -> str:
    return f"http://{HOST}:{PORT}/v1"


def _find_binary() -> pathlib.Path:
    name = "llama-server.exe" if sys.platform == "win32" else "llama-server"
    candidates = sorted(LLAMA_DIR.rglob(name))
    if not candidates:
        raise SetupRequiredError(
            f"llama-server が見つかりません: {LLAMA_DIR}\n"
            f"`uv run python scripts/setup_llama.py` を実行してください。"
        )
    return candidates[0]


def _find_model() -> pathlib.Path:
    models = sorted((LLAMA_DIR / "models").glob("*.gguf"))
    if not models:
        raise SetupRequiredError(
            f"GGUF モデルが見つかりません: {LLAMA_DIR / 'models'}\n"
            f"`uv run python scripts/setup_llama.py` を実行してください。"
        )
    return models[0]


class LlamaServer:
    """llama-server の起動・停止。

    LLM_BACKEND が local 以外の場合は何もしない（サーバ側 LLM を使う構成）。
    """

    def __init__(self) -> None:
        self._process: subprocess.Popen | None = None

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    async def start(self) -> None:
        binary = _find_binary()
        model = _find_model()

        command = [
            str(binary),
            "--model", str(model),
            "--host", HOST,
            "--port", str(PORT),
            "--ctx-size", os.environ.get("LLAMA_CTX_SIZE", "4096"),
            # チャットテンプレートを GGUF のメタデータから使う
            "--jinja",
            # 推論(thinking)モデルは本文の前に数秒ぶんの思考トークンを出す。
            # 音声対話では最初の発話までの待ち時間に直結するため、既定で無効にする。
            # LFM2.5 での実測: 有効だと最初のトークンまで 5〜14 秒、無効なら 0.3〜0.5 秒。
            # 思考を使いたい場合は LLAMA_REASONING_BUDGET=-1（無制限）を指定する
            "--reasoning-budget", os.environ.get("LLAMA_REASONING_BUDGET", "0"),
        ]
        # 指定が無ければ llama.cpp の自動判定に任せる
        # （M シリーズなど P コア / E コア混在では、単純な CPU 数指定はかえって遅くなる）
        threads = os.environ.get("LLAMA_THREADS")
        if threads:
            command += ["--threads", threads]
        logger.info("llama-server を起動します: %s", model.name)

        # 出力はそのまま親プロセスへ流す（起動失敗の原因が見えるように）
        self._process = subprocess.Popen(command)

        try:
            await self._wait_until_ready()
        except Exception:
            self.stop()
            raise

    async def _wait_until_ready(self) -> None:
        """/health が応答するまで待つ。"""
        deadline = asyncio.get_running_loop().time() + STARTUP_TIMEOUT
        health_url = f"http://{HOST}:{PORT}/health"

        async with httpx.AsyncClient(timeout=5.0) as client:
            while asyncio.get_running_loop().time() < deadline:
                if not self.running:
                    raise SetupRequiredError(
                        "llama-server が起動直後に終了しました。上のログを確認してください。"
                    )
                try:
                    response = await client.get(health_url)
                    if response.status_code == 200:
                        logger.info("llama-server の準備ができました: %s", base_url())
                        return
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.5)

        raise SetupRequiredError(
            f"llama-server が {STARTUP_TIMEOUT:.0f} 秒以内に起動しませんでした。"
        )

    def stop(self) -> None:
        if self._process is None:
            return
        if self._process.poll() is None:
            logger.info("llama-server を停止します")
            self._process.terminate()
            try:
                self._process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._process.kill()
        self._process = None
