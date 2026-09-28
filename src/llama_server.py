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
import socket
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


def _check_port_free() -> None:
    """待ち受けたい場所が空いているかを、起動前に確かめる。

    埋まっていると llama-server は起動した直後に終了する。その理由は
    llama-server 自身の出力に紛れてしまい、「なぜか LLM が使えない」という
    形でしか見えない。先に断って、直し方まで伝える。

    SO_REUSEADDR を立てるのは、直前まで使っていた後片付け（TIME_WAIT）を
    「使用中」と誤判定しないため。待ち受けている相手がいる場合は、これを
    立てても bind は失敗する
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((HOST, PORT))
        except OSError:
            raise SetupRequiredError(
                f"{HOST}:{PORT} は既に使われています。\n"
                f"LLAMA_PORT で別の番号を指定してください（例: LLAMA_PORT=8099）。\n"
                f"前回の llama-server が残っている場合は、そちらを止めてください。"
            )


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
        _check_port_free()

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

    def _died_message(self) -> str:
        """終了した理由を、分かる範囲で言葉にする。

        強制終了された場合、llama-server は何も出力できない。「上のログを
        確認してください」と言っても何も残っていないので、終了コードから
        推し量れることを添える。

        POSIX では、シグナルで終わると returncode が負（-9 なら SIGKILL）。
        シェル経由では 128 + シグナル番号になることがあるため、両方を見る
        """
        code = self._process.returncode if self._process else None
        killed = code in (-9, 137)
        illegal = code in (-4, 132)

        if killed:
            model = _find_model()
            size = model.stat().st_size / (1024 ** 3)
            return (
                f"llama-server が強制終了されました（終了コード {code}）。\n"
                f"メモリ不足の可能性が高いです。モデルの読み込みだけで "
                f"{size:.1f}GB を使い、文脈（LLAMA_CTX_SIZE）のぶんが上に乗ります。\n"
                f"空きを確かめて（free -h）、足りなければ次のどれかを試してください。\n"
                f"  - LLAMA_CTX_SIZE を小さくする（例: 1024）\n"
                f"  - もっと小さいモデルに替える"
                f"（scripts/setup_llama.py --model-repo … --model-file …）\n"
                f"  - LLM_BACKEND=remote にして、別のサーバの LLM を使う"
            )
        if illegal:
            return (
                f"llama-server が異常終了しました（終了コード {code}）。\n"
                f"この CPU では動かせない命令が使われている可能性があります。"
                f"別のビルドを "
                f"https://github.com/ggml-org/llama.cpp/releases から取得して、"
                f"{LLAMA_DIR / 'bin'} を差し替えてください。"
            )
        return (
            f"llama-server が起動直後に終了しました（終了コード {code}）。\n"
            f"上のログに理由が出ていないか確認してください。"
        )

    async def _wait_until_ready(self) -> None:
        """/health が応答するまで待つ。"""
        deadline = asyncio.get_running_loop().time() + STARTUP_TIMEOUT
        health_url = f"http://{HOST}:{PORT}/health"

        async with httpx.AsyncClient(timeout=5.0) as client:
            while asyncio.get_running_loop().time() < deadline:
                if not self.running:
                    raise SetupRequiredError(self._died_message())
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
