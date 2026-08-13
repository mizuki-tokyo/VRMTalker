"""プロジェクトルートの解決。

Python のソースは src/ 配下に置き、実行時のデータ（voicevox_core/ や llama/）は
プロジェクトルートに置く。両者の位置関係をここ 1 箇所で管理する。
"""
from __future__ import annotations

import pathlib

# このファイルは <project root>/src/project_paths.py にある
PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
