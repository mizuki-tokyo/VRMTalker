"""ローカル LLM の実行に必要なファイル一式を取得する。

    uv run python scripts/setup_llama.py

取得されるもの:
    llama/bin/     llama.cpp の事前ビルド済みバイナリ（llama-server 等）
    llama/models/  GGUF 形式のモデル

llama.cpp は事前ビルド済みバイナリを配布しているため、ソースビルドは不要。
モデルは既定で LFM2.5-2.6B の Q4_K_M（約 1.5GB）を取得する。
"""
from __future__ import annotations

import argparse
import platform
import shutil
import stat
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LLAMA_DIR = PROJECT_ROOT / "llama"
BIN_DIR = LLAMA_DIR / "bin"
MODELS_DIR = LLAMA_DIR / "models"

LLAMA_CPP_RELEASE = "b10298"

# 既定のモデル。on-device 向けに設計された 2.6B で、公式 GGUF が配布されている
DEFAULT_MODEL_REPO = "LiquidAI/LFM2.5-2.6B-GGUF"
DEFAULT_MODEL_FILE = "LFM2.5-2.6B-Q4_K_M.gguf"


def detect_asset() -> str:
    """実行環境に対応する llama.cpp のリリースアセット名を返す。"""
    machine = platform.machine().lower()
    is_arm = machine in ("arm64", "aarch64")

    if sys.platform == "darwin":
        return f"llama-{LLAMA_CPP_RELEASE}-bin-macos-{'arm64' if is_arm else 'x64'}.tar.gz"
    if sys.platform == "win32":
        return f"llama-{LLAMA_CPP_RELEASE}-bin-win-cpu-{'arm64' if is_arm else 'x64'}.zip"
    raise SystemExit(
        f"このスクリプトは {sys.platform} に対応していません。"
        f"https://github.com/ggml-org/llama.cpp/releases から手動で取得し、"
        f"{BIN_DIR} に配置してください。"
    )


def make_reporter():
    """進捗を 1% 刻みでのみ表示する（毎ブロック出すとログが埋まる）。"""
    last = -1

    def report(count: int, block_size: int, total: int) -> None:
        nonlocal last
        if total <= 0:
            return
        done = min(count * block_size, total)
        percent = done * 100 // total
        if percent != last:
            last = percent
            end = "\n" if percent == 100 else ""
            print(f"\r  {percent:3d}%  {done/1048576:8.1f} / {total/1048576:.1f} MB",
                  end=end, flush=True)

    return report


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    print(f"取得しています: {url}")
    # ブラウザ経由で無いため、macOS の隔離属性 (com.apple.quarantine) は付かない
    urllib.request.urlretrieve(url, destination, reporthook=make_reporter())


def extract(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(destination)
    else:
        with tarfile.open(archive) as tf:
            tf.extractall(destination)

    # 実行権限を付ける（zip / tar から復元されないことがある）
    for path in destination.rglob("*"):
        if path.is_file() and (path.name.startswith("llama-") or path.suffix in ("", ".dylib", ".so")):
            path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def setup_binary(force: bool) -> None:
    asset = detect_asset()
    marker = BIN_DIR / f".{LLAMA_CPP_RELEASE}"

    if marker.exists() and not force:
        print(f"llama.cpp {LLAMA_CPP_RELEASE} は取得済みです: {BIN_DIR}")
        return

    if BIN_DIR.exists():
        shutil.rmtree(BIN_DIR)

    url = f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_CPP_RELEASE}/{asset}"
    archive = LLAMA_DIR / asset
    download(url, archive)
    extract(archive, BIN_DIR)
    archive.unlink()
    marker.touch()
    print(f"展開しました: {BIN_DIR}")


def setup_model(repo: str, filename: str, force: bool) -> None:
    destination = MODELS_DIR / filename
    if destination.exists() and not force:
        print(f"モデルは取得済みです: {destination}")
        return

    url = f"https://huggingface.co/{repo}/resolve/main/{filename}"
    download(url, destination)
    print(f"保存しました: {destination}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model-repo", default=DEFAULT_MODEL_REPO,
                        help=f"Hugging Face のリポジトリ（既定: {DEFAULT_MODEL_REPO}）")
    parser.add_argument("--model-file", default=DEFAULT_MODEL_FILE,
                        help=f"GGUF のファイル名（既定: {DEFAULT_MODEL_FILE}）")
    parser.add_argument("--skip-model", action="store_true",
                        help="モデルを取得せず、バイナリのみ用意する")
    parser.add_argument("--force", action="store_true",
                        help="取得済みでも再取得する")
    args = parser.parse_args()

    setup_binary(args.force)
    if not args.skip_model:
        setup_model(args.model_repo, args.model_file, args.force)

    print("\n完了しました。`uv run uvicorn main:app --port 8000` で起動できます。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
