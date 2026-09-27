#!/bin/bash

PORT=8000

# 合言葉などの設定は .env に置く（git には入れない。.env.example を写して使う）
if [ -f .env ]; then
    set -a
    . ./.env
    set +a
fi

uv run uvicorn main:app --port ${PORT}
