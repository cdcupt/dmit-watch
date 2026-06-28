#!/usr/bin/env bash
# start.sh — boot the dmit-watch stack (TECH §07 run model).
#
#   1. ALWAYS (re)launch a fresh dedicated Chrome, HEADLESS (--headless=new, no
#      visible window) on the CDP debug port (a SEPARATE --user-data-dir; Chrome
#      136+/149 refuses the debug port on the default profile — see TECH §02). We
#      kill any stale dedicated Chrome first so a launchd restart can't race a
#      dying one (below).
#   2. exec the Node watcher under `caffeinate` so the Mac stays awake ONLY while
#      the watcher lives (the assertion is released the moment node exits).
#
# launchd (com.dmit-watch.agent.plist) runs this with RunAtLoad + KeepAlive.
# Reading stock is PUBLIC (no DMIT login needed) and `--headless=new` on the real
# Chrome binary — with a realistic desktop User-Agent — auto-clears the Cloudflare
# challenge (verified). The persistent profile stays CF-cleared on disk, so steady
# loads usually skip the challenge; src/chrome.js also waits out a transient one.

set -euo pipefail

RUNTIME_DIR="${DMIT_WATCH_DIR:-$HOME/.dmit-watch}"
CHROME_PROFILE="${DMIT_WATCH_CHROME_PROFILE:-$RUNTIME_DIR/chrome-profile}"
DEBUG_PORT="${DMIT_WATCH_CHROME_PORT:-9444}"
CHROME_BIN="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
NODE_BIN="${NODE_BIN:-node}"

# Realistic desktop Chrome User-Agent. --headless=new otherwise advertises a
# "HeadlessChrome/…" token that Cloudflare fingerprints and 403s; a normal Mac
# Chrome UA (NO "Headless" token) is what makes the headless read pass (verified).
CHROME_UA="${DMIT_WATCH_CHROME_UA:-Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVTOOLS_URL="http://127.0.0.1:${DEBUG_PORT}/json/version"

chrome_up() { curl -sf --max-time 2 "$DEVTOOLS_URL" >/dev/null 2>&1; }

if [ ! -x "$CHROME_BIN" ]; then
  echo "[start] FATAL: Chrome not found at: $CHROME_BIN (set CHROME_BIN)" >&2
  exit 1
fi

# 1) ALWAYS tear down any stale/dying dedicated Chrome, then relaunch a fresh one.
#
# WHY (the restart race): launchd restarts — KeepAlive, or `launchctl kickstart -k`
# — kill the agent's whole process group, which INCLUDES the Chrome the previous
# start.sh backgrounded with `&`. That Chrome dies *asynchronously*: for a ~1-2s
# window its debug port still answers. An older "if chrome_up; skip relaunch"
# check would see that dying port as healthy, skip the relaunch, and then the old
# Chrome would finish dying — leaving the watcher to attach to nothing
# (ECONNREFUSED :${DEBUG_PORT}) and stay blind until backoff recovery (~1-2 min).
# For a 24/7 restock watcher that is unacceptable, so every start is deterministic:
# kill first, wait for exit, bring up a known-good Chrome. Cloudflare clearance
# persists on disk in the profile and re-clears on first read (verified), so a
# fresh Chrome is fine.
#
# SAFETY (why this can NEVER hit the operator's everyday Chrome): the match is
# pinned to flags UNIQUE to our dedicated instance — the debug-port flag and the
# dedicated --user-data-dir path. A normal Chrome runs on the default profile with
# no such flags (Chrome 136+/149 refuses a debug port on the default profile
# anyway — TECH §02), so it cannot match either pattern.
if pkill -f -- "remote-debugging-port=${DEBUG_PORT}" 2>/dev/null; then
  echo "[start] killed stale dedicated Chrome (remote-debugging-port=${DEBUG_PORT})"
fi
# Second narrow pattern: the dedicated profile path, in case a held-open Chrome
# survives without the port flag. Still unique to us — never the default profile.
pkill -f -- "--user-data-dir=${CHROME_PROFILE}" 2>/dev/null || true

# Wait (cap ~5s) for the old debug port to stop answering before we relaunch.
for _ in $(seq 1 10); do
  chrome_up || break
  sleep 0.5
done

mkdir -p "$CHROME_PROFILE"
echo "[start] launching fresh dedicated Chrome on :${DEBUG_PORT} (profile: $CHROME_PROFILE)"
# --remote-allow-origins is an EXACT scheme://host:port match against the CDP
# WebSocket Origin our connect endpoint sends (src/chrome.js). Both pin 127.0.0.1
# — a localhost↔127.0.0.1 mismatch 403s the handshake and the watcher never reads.
# --headless=new runs Chrome with NO visible window (the operator doesn't want a
# Chrome window kept open); --user-agent presents a normal desktop Chrome so
# Cloudflare doesn't 403 the headless client (see CHROME_UA above).
"$CHROME_BIN" \
  --headless=new \
  --user-agent="$CHROME_UA" \
  --user-data-dir="$CHROME_PROFILE" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$DEBUG_PORT" \
  --remote-allow-origins="http://127.0.0.1:${DEBUG_PORT}" \
  --no-first-run \
  --no-default-browser-check \
  >>"$RUNTIME_DIR/chrome.out.log" 2>&1 &

for _ in $(seq 1 30); do
  chrome_up && break
  sleep 1
done
if ! chrome_up; then
  echo "[start] FATAL: Chrome did not expose :${DEBUG_PORT} within 30s" >&2
  echo "[start] (check $RUNTIME_DIR/chrome.out.log; Chrome runs headless so there is no window)" >&2
  exit 1
fi
echo "[start] Chrome ready on :${DEBUG_PORT}"

# 2) Run the watcher, keeping the Mac awake only for the duration of the process.
echo "[start] starting watcher under caffeinate"
cd "$REPO_DIR"
exec caffeinate -dimsu "$NODE_BIN" "$REPO_DIR/src/index.js"
