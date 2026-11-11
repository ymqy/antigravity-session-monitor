#!/bin/sh
# Resilient zero-blocking wrapper for Antigravity Session Monitor lifecycle hooks.
# Never blocks or alters tool permissions; always emits valid hook contract JSON.

EVENT_NAME="${1:-Unknown}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

# Ensure node is discoverable even when Antigravity is launched directly from macOS Dock/Finder
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NODE_BIN="$(ls -1d "$HOME/.nvm/versions/node/"*/bin 2>/dev/null | tail -n 1)"
  if [ -n "$LATEST_NODE_BIN" ]; then
    export PATH="$LATEST_NODE_BIN:$PATH"
  fi
fi

if command -v node >/dev/null 2>&1; then
  OUT="$(node "$SCRIPT_DIR/hook_collector.mjs" "$EVENT_NAME" 2>/dev/null)"
  if [ -n "$OUT" ]; then
    printf '%s\n' "$OUT"
    exit 0
  fi
fi

if [ "$EVENT_NAME" = "Stop" ]; then
  printf '{"decision":"stop"}\n'
else
  printf '{}\n'
fi
