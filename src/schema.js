// SQLite schema for dmit-watch. Five small tables (TECH §05 ERD):
//   plans         — one row per watched SKU; the panel renders straight from here.
//   family_health — per loc/gen poll outcome + backoff (diagnostics rows).
//   transitions   — append-only OUT<->IN history; powers History + "in stock for X".
//   telegram_log  — one row per alert send attempt; powers the sent ✓/✗ badge.
//   heartbeat     — singleton liveness (last tick, uptime, chrome session).
//
// last_known (OUT|IN) is the edge basis and never leaves that binary; status is the
// richer DISPLAY value and may be UNKNOWN/CHECKING without ever moving the edge.
// Built idempotently at boot (CREATE TABLE IF NOT EXISTS) — editing the watchlist
// reconciles plans without a migration. Timestamps are Unix epoch ms (UTC).

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS family_health (
  family        TEXT PRIMARY KEY,            -- loc/gen, e.g. "lax/as3"
  loc           TEXT NOT NULL,
  gen           TEXT NOT NULL,
  label         TEXT,                         -- e.g. "LAX·AS3"
  last_poll_ts  INTEGER,
  backoff_level INTEGER NOT NULL DEFAULT 0,
  last_outcome  TEXT,                         -- ok | 403 | err
  chrome_state  TEXT
);

CREATE TABLE IF NOT EXISTS plans (
  id           TEXT PRIMARY KEY,             -- "{loc}-{gen}-{size}", e.g. "lax-an4-medium"
  family       TEXT NOT NULL REFERENCES family_health(family),
  loc          TEXT NOT NULL,
  gen          TEXT NOT NULL,
  size         TEXT NOT NULL,
  name         TEXT NOT NULL,                -- display, e.g. "LAX.AN4.Pro.MEDIUM"
  price        TEXT NOT NULL,
  popular      INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'OUT',  -- display: OUT | IN | UNKNOWN | CHECKING
  last_known   TEXT NOT NULL DEFAULT 'OUT',  -- edge basis: OUT | IN only
  armed        INTEGER NOT NULL DEFAULT 1,
  last_checked INTEGER,
  last_change  INTEGER,
  pid_cache    TEXT,                          -- opportunistic; never required
  watch        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (loc, gen, size)
);

CREATE TABLE IF NOT EXISTS transitions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id           TEXT NOT NULL REFERENCES plans(id),
  from_status       TEXT NOT NULL,
  to_status         TEXT NOT NULL,
  ts                INTEGER NOT NULL,
  duration_in_stock INTEGER                   -- seconds, set on IN->OUT
);
CREATE INDEX IF NOT EXISTS idx_trans ON transitions (plan_id, ts);

CREATE TABLE IF NOT EXISTS telegram_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id   TEXT REFERENCES plans(id),       -- null for global (blind-watcher) alerts
  ts        INTEGER NOT NULL,                 -- canonical event time (epoch ms)
  deep_link TEXT,
  message   TEXT,
  sent_ok   INTEGER NOT NULL DEFAULT 0,
  attempts  INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_ts   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tg ON telegram_log (ts);

CREATE TABLE IF NOT EXISTS heartbeat (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  tick_ts        INTEGER,
  uptime_started INTEGER,
  chrome_session TEXT
);
`;
