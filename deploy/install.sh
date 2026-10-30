#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT=/etc/systemd/system/ai-terminal-bridge.service

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root"
  exit 1
fi

cd "$ROOT"
[ -d node_modules ] || npm install --omit=dev

TOKEN_FILE="${AITB_STATE_DIR:-$HOME/.ai-terminal-bridge}/token"
mkdir -p "$(dirname "$TOKEN_FILE")"
chmod 700 "$(dirname "$TOKEN_FILE")"
if [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(cat "$TOKEN_FILE")"
else
  TOKEN="${AITB_TOKEN:-admin}"
  printf '%s\n' "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
fi

sed "s|__REPLACE_WITH_TOKEN__|$TOKEN|; s|/workspace/ai-terminal-bridge|$ROOT|g" \
  deploy/ai-terminal-bridge.service > "$UNIT"

systemctl daemon-reload
systemctl enable --now ai-terminal-bridge
systemctl --no-pager status ai-terminal-bridge || true

echo
echo "token stored in $TOKEN_FILE"
