---
name: setup
description: Install, configure, and start dmit-restock-watch (the DMIT Premium-network restock monitor) on this Mac. Installs the dependency, optionally sets up the user's Telegram bot (token + auto-fetched chat id; skip = panel-only), starts the watcher, and verifies it's reading. Use when the user wants to install / set up / configure / get the watcher running.
---

# Set up dmit-restock-watch

You are an AI agent setting up this DMIT Premium-network **restock watcher** on the user's machine. It checks DMIT's perpetually-sold-out Premium plans ~every 5 minutes and alerts the user (an on-screen panel + optional Telegram) the instant one is buyable. It runs locally; there is **no auto-buy** and **no DMIT login is needed** (stock is public — the user only signs into DMIT in their own browser when they click Buy).

Work from the repo root. Be interactive: do each step, show the result, and only continue when it succeeds. **Never print or commit the user's Telegram bot token** — it goes only into `~/.dmit-watch/config` (chmod 600), never into the repo, a commit, or chat output.

## Step 0 — Preconditions
- `uname` must be `Darwin`. If it is **not** macOS: tell the user the helper scripts (`caffeinate` + `launchd`) are macOS-only; the core Node watcher still works but they must launch Chrome with the debug flags themselves and run `node src/index.js` + use their own service manager. Then stop unless they want to proceed manually. (Linux/systemd hosting and the public stock board — which also offers visitors optional per-plan Telegram restock subscriptions — are covered in [README.md](../../../README.md) and [ops/](../../../ops/).)
- `node -v` must be **≥ 24** (the app uses the built-in `node:sqlite`). If older, ask them to upgrade Node and stop.
- Google Chrome must exist at `/Applications/Google Chrome.app` (or have them set `CHROME_BIN`). 

## Step 1 — Install the dependency
```bash
npm install
```
(Just `playwright-core` — used only to attach to Chrome over CDP; it never launches a browser.)

## Step 2 — (Optional) Configure Telegram
Telegram is **optional**: with credentials the user gets phone restock alerts; without them the watcher runs panel-only (it boots fine and logs `telegram: disabled (no credentials)`). Ask the user whether they want Telegram alerts — if not, skip to Step 3.

If yes, the user needs **two values**, both for a Telegram bot they create. Walk them through it:

1. **Bot token** — tell the user: in Telegram, message **@BotFather**, send `/newbot`, follow the prompts, and copy the **bot token** it returns (looks like `123456789:AA...`). Ask them to give you the token (or, if they prefer, to paste it into `~/.dmit-watch/config` themselves — see below). Treat it as a secret: do not echo it back or write it anywhere except the config file.
2. **Have them message the bot** — tell the user to open their new bot (BotFather gives a `t.me/<botname>` link), press **START**, and send any message (e.g. `hi`). This is required — Telegram won't reveal the chat id until the bot has received a message.
3. **Auto-fetch the chat id** — run (substitute the token):
   ```bash
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" \
     | python3 -c "import sys,json;u=json.load(sys.stdin).get('result',[]);ids=[m['message']['chat']['id'] for m in u if 'message' in m];print(ids[-1] if ids else 'NONE')"
   ```
   If it prints `NONE`, the user hasn't messaged the bot yet (or pressed START) — ask them to do so and retry. (Also run `.../deleteWebhook` once if a stale webhook is set: `curl -s "https://api.telegram.org/bot<TOKEN>/deleteWebhook"`.)
4. **Write the secrets file** (outside the repo, locked down):
   ```bash
   mkdir -p ~/.dmit-watch
   cp config/secrets.example ~/.dmit-watch/config
   chmod 600 ~/.dmit-watch/config
   ```
   Then put the two values in `~/.dmit-watch/config`:
   ```
   TELEGRAM_BOT_TOKEN=<the token>
   TELEGRAM_CHAT_ID=<the id from step 3>
   ```
   Write them with the file tools or `printf` — never with a command that echoes the token to stdout.
5. **(Recommended) send a test message** to confirm the channel works:
   ```bash
   curl -s -X POST "https://api.telegram.org/bot<TOKEN>/sendMessage" \
     --data-urlencode chat_id="<ID>" --data-urlencode text="✅ dmit-restock-watch is connected." | python3 -c "import sys,json;print('telegram ok:',json.load(sys.stdin).get('ok'))"
   ```
   Ask the user to confirm they got it on their phone.

## Step 3 — Start it
Ask the user whether they want it **running 24/7** (recommended) or just for now:
- **24/7 (autostart at login + keep-awake):**
  ```bash
  bash scripts/install-agent.sh
  ```
- **Just this session (foreground; Ctrl-C to stop):**
  ```bash
  bash scripts/start.sh
  ```
Either way it launches a **headless** dedicated Chrome (no visible window) on the debug port and starts the watcher. The first check can take ~15–20s while Chrome clears Cloudflare; after that it's quick.

## Step 4 — Verify it's reading
```bash
# wait a few seconds, then:
curl -s http://127.0.0.1:7331/api/health | python3 -c "import sys,json;d=json.load(sys.stdin);ok=sum(1 for f in d.get('families',[]) if f.get('outcome')=='ok');print('chrome',d.get('chrome',{}).get('state'),'| families ok',ok,'/',len(d.get('families',[])))"
```
Expect `chrome UP | families ok 6 / 6`. Then open the panel:
```bash
open http://127.0.0.1:7331
```
Tell the user the panel shows every Premium plan's stock status (all sold out today) and will alert them the instant one frees up.

## Step 5 — Done — hand off how to manage it
- **Logs:** `tail -f ~/.dmit-watch/watch.err.log`
- **Stop autostart:** `bash scripts/install-agent.sh --uninstall`
- **Check interval:** edit `settings.cadenceSec` in `config/watchlist.json` (seconds, default 60) or set `DMIT_WATCH_CADENCE_SEC`, then `launchctl kickstart -k gui/$(id -u)/com.dmit-watch.agent`.
- **When a plan restocks:** they'll get a panel alarm (+ a Telegram message, if configured) with a **Buy now** link — they click it and check out in their **own** browser (logged into their own DMIT account). The tool never buys.

## Safety reminders
- The Telegram token (if the user opted in) lives only in `~/.dmit-watch/config` (chmod 600), never in the repo or any commit.
- The panel binds `127.0.0.1` only. Keep the cadence reasonable (default 60s) — this is a polite, single-user, read-only monitor.
