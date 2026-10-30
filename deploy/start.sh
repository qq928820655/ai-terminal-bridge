#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  npm install
fi

TOKEN_FILE="${AITB_STATE_DIR:-$HOME/.ai-terminal-bridge}/token"
if [ -z "${AITB_TOKEN:-}" ] && [ -f "$TOKEN_FILE" ]; then
  AITB_TOKEN="$(cat "$TOKEN_FILE")"
fi
# When unset, the server falls back to the documented default "admin"
# and the web login forces a password change on first use.

export AITB_TOKEN
export AITB_HOST="${AITB_HOST:-127.0.0.1}"
export AITB_PORT="${AITB_PORT:-8787}"

echo "ai-terminal-bridge starting on http://$AITB_HOST:$AITB_PORT"
echo "token file: $TOKEN_FILE"
exec node src/server.js
