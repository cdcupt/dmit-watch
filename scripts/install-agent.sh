#!/usr/bin/env bash
# install-agent.sh — render the launchd template and (re)load the LaunchAgent.
# Idempotent: re-running it bootstraps the runtime dir, rewrites the plist with
# this machine's paths, and reloads the agent.
#
#   bash scripts/install-agent.sh          # install + load
#   bash scripts/install-agent.sh --uninstall
#
# Secrets (~/.dmit-watch/config) and the dedicated, logged-in Chrome profile are
# the operator's one-time manual setup — see TECH §03. This only wires launchd.

set -euo pipefail

RUNTIME_DIR="${DMIT_WATCH_DIR:-$HOME/.dmit-watch}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.dmit-watch.agent"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_DEST="$AGENTS_DIR/$LABEL.plist"
TEMPLATE="$REPO_DIR/scripts/$LABEL.plist.template"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  rm -f "$PLIST_DEST"
  echo "[install-agent] uninstalled $LABEL"
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[install-agent] FATAL: node not on PATH" >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

mkdir -p "$RUNTIME_DIR" "$AGENTS_DIR"
chmod 700 "$RUNTIME_DIR" 2>/dev/null || true

if [ ! -f "$RUNTIME_DIR/config" ]; then
  echo "[install-agent] WARNING: $RUNTIME_DIR/config not found — Telegram secrets are required."
  echo "[install-agent]          copy config/secrets.example there and chmod 600 it before the first run."
fi

sed \
  -e "s#__START_SH__#$REPO_DIR/scripts/start.sh#g" \
  -e "s#__REPO_DIR__#$REPO_DIR#g" \
  -e "s#__RUNTIME_DIR__#$RUNTIME_DIR#g" \
  -e "s#__NODE_DIR__#$NODE_DIR#g" \
  "$TEMPLATE" >"$PLIST_DEST"

chmod +x "$REPO_DIR/scripts/start.sh"

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo "[install-agent] installed + loaded $LABEL"
echo "[install-agent]   plist: $PLIST_DEST"
echo "[install-agent]   logs:  $RUNTIME_DIR/watch.out.log / watch.err.log"
echo "[install-agent] tail logs with: tail -f $RUNTIME_DIR/watch.err.log"
