"""VOICEVOX CORE の実行に必要なファイル一式を取得する。

    python scripts/setup_voicevox.py                    # 現在の環境向け
    python scripts/setup_voicevox.py --os windows --cpu-arch x64
                                                        # 他環境向けを事前に取得

公式ダウンローダを取得して実行するだけのラッパー。
ダウンローダは利用規約への同意を対話的に求めるので、内容を読んで判断すること
（このスクリプトは同意を自動化しない）。

取得されるもの:
    voicevox_core/c_api/        コア本体（OS・CPU 別）
    voicevox_core/onnxruntime/  推論ランタイム（OS・CPU 別）
    voicevox_core/dict/         Open JTalk 辞書（OS 非依存）
    voicevox_core/models/       音声モデル .vvm（OS 非依存）
"""
from __future__ import annotations

import argparse
import platform
import stat
import subprocess
import sys
import urllib.request
from pathlib import Path

DOWNLOADER_VERSION = "0.16.4"
DOWNLOADER_BASE = (
    f"https://github.com/VOICEVOX/voicevox_core/releases/download/{DOWNLOADER_VERSION}"
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = PROJECT_ROOT / "voicevox_core"
DOWNLOADER_DIR = PROJECT_ROOT / ".voicevox_downloader"

# 既定で取得する音声モデル。0.vvm には四国めたん・ずんだもん・春日部つむぎ・
# 雨晴はうの計 10 スタイルが含まれる。全て取得する場合は "*" を指定する
DEFAULT_MODELS_PATTERN = "0.vvm"


def detect_host() -> tuple[str, str]:
    """実行中の環境に対応する (os, cpu_arch) を返す。"""
    os_name = {"darwin": "osx", "win32": "windows"}.get(sys.platform, "linux")
    machine = platform.machine().lower()
    cpu_arch = {
        "arm64": "arm64", "aarch64": "arm64",
        "x86_64": "x64", "amd64": "x64",
    }.get(machine, "x64")
    return os_name, cpu_arch


def downloader_name(os_name: str, cpu_arch: str) -> str:
    if os_name == "windows":
        return "download-windows-x64.exe"
    return f"download-{os_name}-{cpu_arch}"


def fetch_downloader(os_name: str, cpu_arch: str) -> Path:
    """公式ダウンローダを取得する。既に取得済みなら再利用する。"""
    name = downloader_name(*detect_host())  # ダウンローダ自体は実行環境向けが必要
    path = DOWNLOADER_DIR / name

    if not path.exists():
        DOWNLOADER_DIR.mkdir(parents=True, exist_ok=True)
        url = f"{DOWNLOADER_BASE}/{name}"
        print(f"ダウンローダを取得しています: {url}")
        urllib.request.urlretrieve(url, path)
        path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    return path


def main() -> int:
    host_os, host_arch = detect_host()

    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--os", dest="os_name", default=host_os,
                        choices=["osx", "windows", "linux"],
                        help="取得対象の OS（既定: 実行環境）")
    parser.add_argument("--cpu-arch", default=host_arch,
                        choices=["x86", "x64", "arm64"],
                        help="取得対象の CPU アーキテクチャ（既定: 実行環境）")
    parser.add_argument("--models-pattern", default=DEFAULT_MODELS_PATTERN,
                        help=f"取得する .vvm のパターン（既定: {DEFAULT_MODELS_PATTERN}、"
                             f'全て取得するなら "*"）')
    parser.add_argument("--output", type=Path, default=OUTPUT_DIR,
                        help=f"出力先（既定: {OUTPUT_DIR}）")
    args = parser.parse_args()

    downloader = fetch_downloader(args.os_name, args.cpu_arch)

    command = [
        str(downloader),
        "--os", args.os_name,
        "--cpu-arch", args.cpu_arch,
        "--devices", "cpu",
        "--models-pattern", args.models_pattern,
        "--output", str(args.output),
    ]
    print(f"\n実行: {' '.join(command)}\n")

    # 利用規約への同意を求められる。標準入力をそのまま渡し、利用者自身に判断させる
    result = subprocess.run(command)
    if result.returncode != 0:
        print("\nダウンロードに失敗しました。", file=sys.stderr)
        return result.returncode

    print(f"\n完了しました: {args.output}")
    print("生成した音声を利用する際は VOICEVOX のクレジット表記が必要です（README.md 参照）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
