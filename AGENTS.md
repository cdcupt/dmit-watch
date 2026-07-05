# Notes for AI agents

If a user asks you to **install / set up / run** this DMIT restock watcher for them, follow the
step-by-step setup skill:

**[`.claude/skills/setup/SKILL.md`](.claude/skills/setup/SKILL.md)**

It walks you through: prerequisites (macOS, Node ≥ 24, Chrome) → `npm install` → *(optional)* creating
the user's Telegram bot and **auto-fetching their chat id** (skip = panel-only) → writing the secrets file
(`~/.dmit-watch/config`, chmod 600) → starting the watcher (or installing the 24/7 launchd agent) →
verifying it reads.

Key rules:
- **Never print or commit the Telegram bot token.** It belongs only in `~/.dmit-watch/config`. Telegram is **optional** — skipping it means panel-only alerts.
- **No DMIT login is needed** — stock is public; the user buys manually in their own browser.
- The app runs **locally** (panel on `127.0.0.1:7331`); Linux/systemd hosting and the optional public stock board are covered in [README.md](README.md) and [ops/](ops/).

Human-readable setup is in [README.md](README.md).
