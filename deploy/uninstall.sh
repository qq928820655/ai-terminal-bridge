#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root"
  exit 1
fi

systemctl disable --now ai-terminal-bridge 2>/dev/null || true
rm -f /etc/systemd/system/ai-terminal-bridge.service
systemctl daemon-reload
echo "uninstalled"
