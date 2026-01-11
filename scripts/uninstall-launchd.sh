#!/usr/bin/env bash
set -euo pipefail

TARGET_DIR="$HOME/Library/LaunchAgents"

for svc in com.lanai.proxy com.lanai.mcp-http; do
  plist="$TARGET_DIR/$svc.plist"
  if [[ -f "$plist" ]]; then
    launchctl unload -w "$plist" 2>/dev/null || true
    rm -f "$plist"
  fi
  echo "Removed $svc"
done
