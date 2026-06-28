# dmit-restock-watch

A small, always-on **restock watcher for [DMIT](https://www.dmit.io)'s Premium-network VPS plans** (the
CN2 GIA / "Pro" line that's perpetually sold out). It checks every Premium plan about once a minute and
**alerts you the instant one becomes buyable** — via Telegram and an on-screen alarm — so you can grab it
manually inside the short window before it sells out again.

It runs **locally on your Mac**, in the background. There's **no auto-buy** — the tool's only job is to
notify you fast and deep-link you straight to the right cart page.

> macOS-oriented (uses `caffeinate` + a `launchd` agent). The core watcher is plain Node and portable;
> only the start/autostart scripts assume macOS.

## How it works

DMIT has **no public stock API**, and `cart.php` sits behind **Cloudflare** — plain HTTP (and even a
Playwright-*launched* browser) gets a `403`. So the watcher never launches its own automated browser:

1. **Read past Cloudflare.** It starts a dedicated Google Chrome in **new headless mode** (`--headless=new`,
   no visible window) on its own profile + a CDP debug port, and **attaches** to it over CDP
   (`connectOverCDP`). A real Chrome binary in new-headless mode clears Cloudflare's challenge on its own.
   No DMIT login is needed — stock is public.
2. **Detect conservatively.** Stock is keyed on the visible **"Out of Stock"** label. A read/parse failure
   is **UNKNOWN** and is *never* promoted to "in stock" — a false in-stock alert is structurally impossible.
   A plan is only called IN when it clears sanity gates (name + price parsed, expected plan count, a control
   group of other plans still OUT the same cycle).
3. **Alert on the edge.** When a plan crosses **OUT → IN**, it fires once: a **Telegram** message
   (plan, price, datacenter · network, Buy link, time) and an **on-panel alarm** (banner + sound + browser
   notification). A blind-watcher safety net surfaces on the panel if the reader looks broken, so a silent
   failure can't hide a restock.
4. **You buy manually.** Each alert carries a **Buy-now deep link** to the exact `cart.php` picker. The tool
   never auto-buys.

The panel is a localhost dashboard that mirrors DMIT's store layout (Datacenter → Generation → Instance
Scale), leading with each plan's **stock status**, and updates live over SSE with a connection/stale indicator.

## Requirements

- **Node.js ≥ 24** (uses the built-in `node:sqlite` and `node:test` — no external DB or test deps)
- **Google Chrome** at `/Applications/Google Chrome.app` (set `CHROME_BIN` to override)
- One npm dependency: **`playwright-core`** (only to CDP-attach to the dedicated Chrome — it never launches a browser)

```bash
npm install
```

## Quick start

```bash
# 1. Install
npm install

# 2. Telegram: create a bot via @BotFather → token; message the bot once → chat id from getUpdates
cp config/secrets.example ~/.dmit-watch/config
chmod 600 ~/.dmit-watch/config
#   then fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
#   chat id: curl "https://api.telegram.org/bot<token>/getUpdates"  → result[].message.chat.id

# 3. Start the watcher + panel (launches the headless dedicated Chrome, runs under caffeinate)
bash scripts/start.sh

# 4. Open the panel
open http://127.0.0.1:7331

# 5. (optional) run 24/7 — install the launchd agent (autostart at login + keep-awake)
bash scripts/install-agent.sh           # bash scripts/install-agent.sh --uninstall  to remove
```

That's it — no DMIT login, no visible browser window. Telegram alerts reach your phone; the panel is the
desk-side view. Logs: `tail -f ~/.dmit-watch/watch.err.log`.

## Configuration

- **`config/watchlist.json`** — the watched plans + settings.
  - `settings.cadenceSec` — how often each plan is checked, in **seconds** (default **60**). A small ±10%
    jitter is applied for politeness; values below a 20s floor are clamped. You can also override at runtime
    with the env var `DMIT_WATCH_CADENCE_SEC`. Apply changes with:
    `launchctl kickstart -k gui/$(id -u)/com.dmit-watch.agent` (or restart `start.sh`).
- **`~/.dmit-watch/config`** — your Telegram secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
  Kept outside the repo, `chmod 600`, never committed.

## Privacy & safety

- **No secrets in the repo.** Telegram credentials live only in `~/.dmit-watch/config`.
- **No DMIT password is stored** — reading stock is public; buying happens in your normal browser via the link.
- **The panel binds `127.0.0.1` only** (loopback), with CSRF-guarded state-changing endpoints.
- **Be polite.** Keep the cadence reasonable (the default 60s with jitter is fine for a single user); this is
  a personal, low-frequency, read-only monitor — please don't hammer DMIT.

## Run the tests

```bash
node --test
```

## License

[MIT](LICENSE) — provided as-is; not affiliated with or endorsed by DMIT.
