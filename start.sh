#!/bin/bash

PORT=8000
#export LLM_SYSTEM_PROMPT=""

uv run uvicorn main:app --port ${PORT}
