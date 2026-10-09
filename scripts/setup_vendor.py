"""ブラウザで使うライブラリを public/vendor/ に取得する。

    uv run python scripts/setup_vendor.py

取得したものは git に入れてあるので、ふだんは実行しなくてよい。
ライブラリの版を上げるときだけ、下の PACKAGES の版を書き換えて実行し直す。

    public/vendor/three@0.169.0/                      three.js 本体と追加部品
    public/vendor/@pixiv/three-vrm@3.5.5/             VRM の読み込みと制御
    public/vendor/@pixiv/three-vrm-animation@3.4.2/   VRMA の読み込み
    public/vendor/blockly@13.2.1/                     ブロックの編集画面（画像・音を含む）
    public/vendor/marked@15.0.12/                     リソースの出典の表示
    public/vendor/onnxruntime-web@1.22.0/             連続対話の発話検出（Silero VAD）を動かす
    public/vendor/silero-vad@5.1.2/                   連続対話の発話検出のモデル

CDN から読まずに手元に置くのは、ネットワークが無くても（LLM を手元で
動かしていれば、音声認識を除いて）動くようにするため。版も確実に固定される。

版を上げたら、読み込む側の参照も書き換えること。

    three・three-vrm・three-vrm-animation   public/index.html の importmap
    blockly                                  public/js/app-block-editor.js の BLOCKLY_VERSION
    marked                                   public/js/app-credits.js の MARKED_URL
    onnxruntime-web・silero-vad              public/js/speech-hands-free/silero-vad.js

古い版のフォルダは消さないので、要らなくなったら手で消す。
"""
from __future__ import annotations

import json
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
VENDOR_DIR = PROJECT_ROOT / "public" / "vendor"

NPM_BASE = "https://cdn.jsdelivr.net/npm"
NPM_LISTING = "https://data.jsdelivr.com/v1/package/npm"
GITHUB_BASE = "https://cdn.jsdelivr.net/gh"


@dataclass
class Package:
    name: str
    version: str
    # パッケージの中のファイル。読み込む側が使うものだけを取る
    files: list[str]
    # このディレクトリの中身を、すべて取る（版ごとに中身が変わるもの）
    directories: list[str] = field(default_factory=list)
    # ライセンスの写し。パッケージの中のパスか、完全な URL（{version} は版に置き換える）
    license: str = "LICENSE"
    # npm ではなく GitHub のリポジトリから取るときの "持ち主/名前"。版は v<版> のタグ
    github: str | None = None

    @property
    def folder(self) -> Path:
        return VENDOR_DIR / f"{self.name}@{self.version}"

    def url(self, path: str) -> str:
        if self.github:
            return f"{GITHUB_BASE}/{self.github}@v{self.version}/{path}"
        return f"{NPM_BASE}/{self.name}@{self.version}/{path}"


PACKAGES = [
    Package(
        "three", "0.169.0",
        files=[
            "build/three.module.min.js",
            # 使っている追加部品と、それらが読み込むもの
            "examples/jsm/controls/OrbitControls.js",
            "examples/jsm/loaders/GLTFLoader.js",
            "examples/jsm/utils/BufferGeometryUtils.js",
            "examples/jsm/loaders/FBXLoader.js",
            "examples/jsm/libs/fflate.module.js",
            "examples/jsm/curves/NURBSCurve.js",
            "examples/jsm/curves/NURBSUtils.js",
        ],
    ),
    Package("@pixiv/three-vrm", "3.5.5", files=["lib/three-vrm.module.min.js"]),
    Package("@pixiv/three-vrm-animation", "3.4.2",
            files=["lib/three-vrm-animation.module.min.js"]),
    Package(
        "blockly", "13.2.1",
        files=["blockly.min.js", "msg/ja.js"],
        # 拡大・縮小ボタンやゴミ箱の絵、効果音、カーソル（inject() の media）
        directories=["media"],
        # npm のパッケージにはライセンスが入っていないので、同じ版の GitHub から取る
        license="https://cdn.jsdelivr.net/gh/google/blockly@blockly-v{version}/LICENSE",
    ),
    Package("marked", "15.0.12", files=["marked.min.js"], license="LICENSE.md"),
    Package(
        "onnxruntime-web", "1.22.0",
        # ES モジュール版の本体と、それが読み込む WebAssembly 一式（CPU 版）
        files=[
            "dist/ort.wasm.min.mjs",
            "dist/ort-wasm-simd-threaded.mjs",
            "dist/ort-wasm-simd-threaded.wasm",
        ],
        # npm のパッケージにはライセンスが入っていないので、同じ版の GitHub から取る
        license="https://cdn.jsdelivr.net/gh/microsoft/onnxruntime@v{version}/LICENSE",
    ),
    # 発話検出のモデル。配布元のリポジトリから取る
    Package("silero-vad", "5.1.2", files=["src/silero_vad/data/silero_vad.onnx"],
            github="snakers4/silero-vad"),
]


def list_directory(package: Package, directory: str) -> list[str]:
    """パッケージの中の、あるディレクトリにあるファイルの一覧（パッケージからの相対パス）。"""
    with urllib.request.urlopen(f"{NPM_LISTING}/{package.name}@{package.version}") as response:
        entries = json.load(response)["files"]
    for part in directory.split("/"):
        entries = next(e["files"] for e in entries
                       if e["type"] == "directory" and e["name"] == part)
    return [f"{directory}/{e['name']}" for e in entries if e["type"] == "file"]


def download(url: str, destination: Path) -> int:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".part")
    with urllib.request.urlopen(url) as response:
        temporary.write_bytes(response.read())
    temporary.replace(destination)  # 途中で失敗しても、壊れたファイルを残さない
    return destination.stat().st_size


def main() -> int:
    total = 0
    for package in PACKAGES:
        print(f"{package.name}@{package.version}")
        paths = list(package.files)
        for directory in package.directories:
            paths += list_directory(package, directory)

        for path in paths:
            size = download(package.url(path), package.folder / path)
            total += size
            print(f"  {path} ({size:,} バイト)")

        license = package.license.format(version=package.version)
        license_url = license if license.startswith("https://") else package.url(license)
        license_name = Path(package.license).name
        total += download(license_url, package.folder / license_name)
        print(f"  {license_name}")

    print(f"合計 {total:,} バイトを {VENDOR_DIR.relative_to(PROJECT_ROOT)} に取得しました")
    return 0


if __name__ == "__main__":
    sys.exit(main())
