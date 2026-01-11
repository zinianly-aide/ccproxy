#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE="$ROOT_DIR/.env"
TARGET_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/lanai"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

set -a
LANAI_API_KEY=${LANAI_API_KEY:-"change-me"}
LAN_ALLOW_CIDRS=${LAN_ALLOW_CIDRS:-"10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1/32"}
REPO_ROOT=${REPO_ROOT:-"$HOME/code"}
PROXY_HOST=${PROXY_HOST:-"0.0.0.0"}
PROXY_PORT=${PROXY_PORT:-"8787"}
MCP_HTTP_HOST=${MCP_HTTP_HOST:-"0.0.0.0"}
MCP_HTTP_PORT=${MCP_HTTP_PORT:-"8788"}
MCP_HTTP_BASE_URL=${MCP_HTTP_BASE_URL:-"http://127.0.0.1:$MCP_HTTP_PORT"}
MODELS_CONFIG=${MODELS_CONFIG:-"$REPO_ROOT/configs/models.yaml"}
RATE_LIMIT_PER_MIN=${RATE_LIMIT_PER_MIN:-"120"}
CORS_ALLOW_ORIGINS=${CORS_ALLOW_ORIGINS:-""}
OLLAMA_URL=${OLLAMA_URL:-"http://127.0.0.1:11434"}
GEMINI_BIN=${GEMINI_BIN:-"gemini"}
GEMINI_ARGS=${GEMINI_ARGS:-""}
CODEX_PROVIDER=${CODEX_PROVIDER:-"cli"}
CODEX_BIN=${CODEX_BIN:-"codex"}
CODEX_ARGS=${CODEX_ARGS:-""}
CODEX_API_KEY=${CODEX_API_KEY:-""}
CODEX_BASE_URL=${CODEX_BASE_URL:-""}
CODEX_CWD=${CODEX_CWD:-""}
CODEX_SANDBOX=${CODEX_SANDBOX:-"read-only"}
CODEX_FULL_AUTO=${CODEX_FULL_AUTO:-"false"}
CODEX_ALLOW_SEARCH=${CODEX_ALLOW_SEARCH:-"false"}
LOG_LEVEL=${LOG_LEVEL:-"info"}
PATH_VALUE=${PATH:-"/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"}

expand_path() {
  local input=$1
  if [[ "$input" == "~" ]]; then
    echo "$HOME"
    return
  fi
  if [[ "$input" == ~/* ]]; then
    echo "$HOME/${input#~/}"
    return
  fi
  echo "$input"
}

REPO_ROOT=$(expand_path "$REPO_ROOT")
CODEX_CWD=$(expand_path "$CODEX_CWD")
MODELS_CONFIG=$(expand_path "$MODELS_CONFIG")
set +a

mkdir -p "$TARGET_DIR" "$LOG_DIR"

render_plist() {
  local template=$1
  local dest=$2
  python3 - "$template" "$dest" <<'PY'
import os
import sys
from pathlib import Path

template = Path(sys.argv[1]).read_text()

replacements = {
    "LANAI_API_KEY": os.environ.get("LANAI_API_KEY", "change-me"),
    "LAN_ALLOW_CIDRS": os.environ.get("LAN_ALLOW_CIDRS", ""),
    "REPO_ROOT": os.environ.get("REPO_ROOT", ""),
    "PROXY_HOST": os.environ.get("PROXY_HOST", ""),
    "PROXY_PORT": os.environ.get("PROXY_PORT", ""),
    "MCP_HTTP_HOST": os.environ.get("MCP_HTTP_HOST", ""),
    "MCP_HTTP_PORT": os.environ.get("MCP_HTTP_PORT", ""),
    "MCP_HTTP_BASE_URL": os.environ.get("MCP_HTTP_BASE_URL", ""),
    "MODELS_CONFIG": os.environ.get("MODELS_CONFIG", ""),
    "RATE_LIMIT_PER_MIN": os.environ.get("RATE_LIMIT_PER_MIN", ""),
    "CORS_ALLOW_ORIGINS": os.environ.get("CORS_ALLOW_ORIGINS", ""),
    "OLLAMA_URL": os.environ.get("OLLAMA_URL", ""),
    "GEMINI_BIN": os.environ.get("GEMINI_BIN", ""),
    "GEMINI_ARGS": os.environ.get("GEMINI_ARGS", ""),
    "CODEX_PROVIDER": os.environ.get("CODEX_PROVIDER", ""),
    "CODEX_BIN": os.environ.get("CODEX_BIN", ""),
    "CODEX_ARGS": os.environ.get("CODEX_ARGS", ""),
    "CODEX_API_KEY": os.environ.get("CODEX_API_KEY", ""),
    "CODEX_BASE_URL": os.environ.get("CODEX_BASE_URL", ""),
    "CODEX_CWD": os.environ.get("CODEX_CWD", ""),
    "CODEX_SANDBOX": os.environ.get("CODEX_SANDBOX", ""),
    "CODEX_FULL_AUTO": os.environ.get("CODEX_FULL_AUTO", ""),
    "CODEX_ALLOW_SEARCH": os.environ.get("CODEX_ALLOW_SEARCH", ""),
    "LOG_LEVEL": os.environ.get("LOG_LEVEL", ""),
    "PATH": os.environ.get("PATH_VALUE", ""),
    "HOME": os.environ.get("HOME", "")
}

for key, value in replacements.items():
    template = template.replace(f"__{key}__", value)

Path(sys.argv[2]).write_text(template)
PY
}

render_plist "$ROOT_DIR/launchd/com.lanai.proxy.plist" "$TARGET_DIR/com.lanai.proxy.plist"
render_plist "$ROOT_DIR/launchd/com.lanai.mcp-http.plist" "$TARGET_DIR/com.lanai.mcp-http.plist"

launchctl unload -w "$TARGET_DIR/com.lanai.proxy.plist" 2>/dev/null || true
launchctl unload -w "$TARGET_DIR/com.lanai.mcp-http.plist" 2>/dev/null || true
launchctl load -w "$TARGET_DIR/com.lanai.proxy.plist"
launchctl load -w "$TARGET_DIR/com.lanai.mcp-http.plist"

echo "LaunchAgents installed. Logs in $LOG_DIR"
