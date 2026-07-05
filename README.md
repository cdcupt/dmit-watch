# dmit-restock-watch

A small, always-on **restock watcher for [DMIT](https://www.dmit.io)'s Premium-network VPS plans** (the
CN2 GIA / "Pro" line that's perpetually sold out). It checks every Premium plan about once a minute and
**alerts you the instant one becomes buyable** — via Telegram (optional) and an on-screen alarm — so you
can grab it manually inside the short window before it sells out again.

It runs **locally on your Mac**, in the background. There's **no auto-buy** — the tool's only job is to
notify you fast and deep-link you straight to the right cart page. It can also feed a **public read-only
stock board** — the reference deployment is live at **<https://vps-stock.daichenlab.com>**.

> macOS-oriented (uses `caffeinate` + a `launchd` agent). The core watcher is plain Node and portable;
> only the start/autostart scripts assume macOS — Linux hosting under systemd is covered in
> [`ops/`](ops/) (the reference watcher runs that way, on a residential-IP VPS).

## How it works

DMIT has **no public stock API**, and `cart.php` sits behind **Cloudflare** — plain HTTP (and even a
Playwright-*launched* browser) gets a `403`. So the watcher never launches its own automated browser:

1. **Read past Cloudflare.** It starts a dedicated Google Chrome in **new headless mode** (`--headless=new`,
   no visible window) on its own profile + a CDP debug port, and **attaches** to it over CDP
   (`connectOverCDP`). A real Chrome binary in new-headless mode clears Cloudflare's challenge on its own —
   **from a residential IP**; datacenter IPs get walled (tested). No DMIT login is needed — stock is public.
2. **Detect conservatively.** Stock is keyed on the visible **"Out of Stock"** label. A read/parse failure
   is **UNKNOWN** and is *never* promoted to "in stock" — a false in-stock alert is structurally impossible.
   A plan is only called IN when it clears sanity gates (name + price parsed, expected plan count, a control
   group of other plans still OUT the same cycle).
3. **Alert on the edge.** When a plan crosses **OUT → IN**, it fires once: a **Telegram** message
   (optional — plan, price, datacenter · network, Buy link, time) and an **on-panel alarm** (banner + sound +
   browser notification). A blind-watcher safety net surfaces on the panel if the reader looks broken, so a
   silent failure can't hide a restock.
4. **You buy manually.** Each alert carries a **Buy-now deep link** to the exact `cart.php` picker. The tool
   never auto-buys.
5. **(Optional) Publish.** The watcher can push each snapshot to a tiny standalone board server
   ([`board-server/`](board-server/) — zero-dep Node: Bearer-gated `POST /api/push`, public `GET /api/state`
   + `GET /healthz`, and the static board page), which serves a **public read-only stock board**. Set
   `DMIT_WATCH_PUSH_URL` / `DMIT_WATCH_PUSH_TOKEN` in `~/.dmit-watch/config`; without them, nothing is
   published. Reference deployment: <https://vps-stock.daichenlab.com>.

The panel is a localhost dashboard that mirrors DMIT's store layout (Datacenter → Generation → Instance
Scale), leading with each plan's **stock status**, and updates live over SSE with a connection/stale indicator.

## Install with an AI agent (easiest)

Open this folder in an AI coding agent (e.g. Claude Code) and ask it to **"set up dmit-restock-watch"**.
It follows the bundled setup skill ([`.claude/skills/setup/SKILL.md`](.claude/skills/setup/SKILL.md)) —
installing the dependency, optionally creating your Telegram bot and **auto-fetching your chat id**, writing
the config, and starting the watcher — so you don't have to run any of it by hand. Prefer to do it yourself?
Follow the manual steps below.

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

# 2. (optional) Telegram: create a bot via @BotFather → token; message the bot once → chat id from getUpdates
cp config/secrets.example ~/.dmit-watch/config
chmod 600 ~/.dmit-watch/config
#   then fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
#   chat id: curl "https://api.telegram.org/bot<token>/getUpdates"  → result[].message.chat.id
#   skip this step entirely to run panel-only — the watcher boots without creds and logs
#   "telegram: disabled (no credentials)"

# 3. Start the watcher + panel (launches the headless dedicated Chrome, runs under caffeinate)
bash scripts/start.sh

# 4. Open the panel
open http://127.0.0.1:7331

# 5. (optional) run 24/7 — install the launchd agent (autostart at login + keep-awake)
bash scripts/install-agent.sh           # bash scripts/install-agent.sh --uninstall  to remove
```

That's it — no DMIT login, no visible browser window. With Telegram configured, restock alerts reach your
phone; without it the panel is still the full desk-side view. Logs: `tail -f ~/.dmit-watch/watch.err.log`.

## Configuration

- **`config/watchlist.json`** — the watched plans + settings.
  - `settings.cadenceSec` — how often each plan is checked, in **seconds** (default **60**). A small ±10%
    jitter is applied for politeness; values below a 20s floor are clamped. You can also override at runtime
    with the env var `DMIT_WATCH_CADENCE_SEC`. Apply changes with:
    `launchctl kickstart -k gui/$(id -u)/com.dmit-watch.agent` (or restart `start.sh`).
- **`~/.dmit-watch/config`** — your secrets, all optional: Telegram (`TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_CHAT_ID`) for restock alerts, and the public-board push target (`DMIT_WATCH_PUSH_URL`,
  `DMIT_WATCH_PUSH_TOKEN`). Kept outside the repo, `chmod 600`, never committed.

### Watching other providers (WHMCS stores)

The watcher is multi-provider. Besides DMIT's Cloudflare-protected cart (which needs the dedicated
Chrome), any **WHMCS store-group page** that renders a per-product `N Available` badge can be watched
over plain HTTPS — no browser involved. Add a family with `"provider": "whmcs"` and a `"url"`, plus one
plan per product whose `name` matches the product title on the page exactly:

```jsonc
// family
{ "key": "hnl/vds", "provider": "whmcs", "loc": "hnl", "gen": "vds", "label": "HNL·VDS",
  "planCount": 4, "url": "https://qq.pw/store/residential-vds-with-dedicated-ip", ... }
// plan
{ "id": "hnl-vds-intern", "family": "hnl/vds", "name": "Dedicate IP VDS Intern",
  "price": "$35.00", "deepLink": "https://qq.pw/store/residential-vds-with-dedicated-ip/dedicate-ip-vds-entry", ... }
```

Stock is the explicit badge: `qty > 0` → **IN** (alert), `0 Available` → OUT, badge/name missing →
UNKNOWN (never promoted to IN; feeds the same blind-watcher net). Non-monthly billing can be labeled
with an optional plan `"period"` (e.g. `"quarter"`). Restart the agent after editing.

## Publish a public stock page

The watcher can feed a **public read-only stock board** (live reference deployment:
<https://vps-stock.daichenlab.com>):

1. **Run [`board-server/`](board-server/) on any host** — a standalone, zero-dependency Node server.
   Env: `PORT` (default 8080), `PUSH_TOKEN` (bearer token gating `POST /api/push`; unset = all pushes
   rejected), `SNAPSHOT_FILE` (where the last snapshot persists across restarts). It serves the static
   board page plus `GET /api/state` and `GET /healthz`.
2. **Point the watcher at it** — set `DMIT_WATCH_PUSH_URL` and `DMIT_WATCH_PUSH_TOKEN` in
   `~/.dmit-watch/config`. The watcher then pushes a snapshot after each check cycle; leave them unset
   and nothing is published.
3. **Deploy assets** — [`ops/`](ops/) has a compose file + Caddy vhost snippet for the board host, and
   systemd units for running the watcher on a Linux host.

> The **watcher host needs a residential IP** for DMIT — datacenter IPs get walled by Cloudflare
> (tested). The board host can be anywhere.

Full design/tech/test/beta paper trail for this feature:
[`docs/pipeline/public-stock-page/`](docs/pipeline/public-stock-page/).

## Privacy & safety

- **No secrets in the repo.** Telegram credentials and the board push token live only in `~/.dmit-watch/config`.
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
