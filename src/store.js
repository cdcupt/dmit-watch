// SQLite store for dmit-watch, built on the built-in node:sqlite (DatabaseSync).
// Single-writer, single-host: synchronous calls are correct and simple. WAL mode
// lets the panel read while the watcher writes. All times are epoch ms (UTC).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from './paths.js';
import { SCHEMA_SQL } from './schema.js';

const DAY_MS = 86_400_000;
const bool = (v) => (v ? 1 : 0);

/**
 * Open (creating if needed) the dmit-watch store and return a small repository
 * facade. `:memory:` is honored for tests.
 */
export function openStore(dbFile = DB_FILE) {
  if (dbFile !== ':memory:') {
    mkdirSync(dirname(dbFile), { recursive: true });
  }
  const db = new DatabaseSync(dbFile);
  if (dbFile !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);

  // Additive migration: CREATE TABLE IF NOT EXISTS never alters an existing DB,
  // so columns added after first ship are back-filled here (idempotent).
  const famCols = new Set(db.prepare('PRAGMA table_info(family_health)').all().map((c) => c.name));
  const FAMILY_HEALTH_MIGRATIONS = [
    ['blind', "ALTER TABLE family_health ADD COLUMN blind INTEGER NOT NULL DEFAULT 0"],
    ['blind_reasons', 'ALTER TABLE family_health ADD COLUMN blind_reasons TEXT'],
    ['blind_since', 'ALTER TABLE family_health ADD COLUMN blind_since INTEGER'],
  ];
  for (const [col, sql] of FAMILY_HEALTH_MIGRATIONS) {
    if (!famCols.has(col)) db.exec(sql);
  }

  // ---- prepared statements -------------------------------------------------
  const stmt = {
    famUpsert: db.prepare(`
      INSERT INTO family_health (family, loc, gen, label)
      VALUES (:family, :loc, :gen, :label)
      ON CONFLICT(family) DO UPDATE SET loc = excluded.loc, gen = excluded.gen, label = excluded.label`),
    famHealthSet: db.prepare(`
      UPDATE family_health
         SET last_poll_ts = :lastPollTs, backoff_level = :backoffLevel,
             last_outcome = :lastOutcome, chrome_state = :chromeState,
             blind = :blind, blind_reasons = :blindReasons, blind_since = :blindSince
       WHERE family = :family`),
    famGet: db.prepare('SELECT * FROM family_health WHERE family = ?'),
    famAll: db.prepare('SELECT * FROM family_health ORDER BY family'),

    planExists: db.prepare('SELECT 1 FROM plans WHERE id = ?'),
    planInsert: db.prepare(`
      INSERT INTO plans (id, family, loc, gen, size, name, price, popular, status, last_known, armed, watch)
      VALUES (:id, :family, :loc, :gen, :size, :name, :price, :popular, 'OUT', 'OUT', 1, :watch)`),
    planDescUpdate: db.prepare(`
      UPDATE plans
         SET family = :family, loc = :loc, gen = :gen, size = :size,
             name = :name, price = :price, popular = :popular, watch = :watch
       WHERE id = :id`),
    planStateUpdate: db.prepare(`
      UPDATE plans
         SET status = :status, last_known = :lastKnown, armed = :armed,
             last_checked = :lastChecked, last_change = :lastChange, pid_cache = :pidCache
       WHERE id = :id`),
    planGet: db.prepare('SELECT * FROM plans WHERE id = ?'),
    planAll: db.prepare('SELECT * FROM plans ORDER BY loc, gen, size'),
    planByFamily: db.prepare('SELECT * FROM plans WHERE family = ? ORDER BY size'),

    transInsert: db.prepare(`
      INSERT INTO transitions (plan_id, from_status, to_status, ts, duration_in_stock)
      VALUES (:planId, :from, :to, :ts, :durationInStock)`),
    transByPlan: db.prepare('SELECT * FROM transitions WHERE plan_id = ? ORDER BY ts DESC LIMIT ?'),
    transRecent: db.prepare('SELECT * FROM transitions ORDER BY ts DESC LIMIT ?'),

    tgInsert: db.prepare(`
      INSERT INTO telegram_log (plan_id, ts, deep_link, message, sent_ok, attempts, last_error, sent_ts)
      VALUES (:planId, :ts, :deepLink, :message, :sentOk, :attempts, :lastError, :sentTs)`),
    tgRecent: db.prepare('SELECT * FROM telegram_log ORDER BY ts DESC LIMIT ?'),

    hbGet: db.prepare('SELECT * FROM heartbeat WHERE id = 1'),
    hbUpsert: db.prepare(`
      INSERT INTO heartbeat (id, tick_ts, uptime_started, chrome_session)
      VALUES (1, :tickTs, :uptimeStarted, :chromeSession)
      ON CONFLICT(id) DO UPDATE SET tick_ts = excluded.tick_ts, chrome_session = excluded.chrome_session`),

    pruneTrans: db.prepare('DELETE FROM transitions WHERE ts < ?'),
    pruneTg: db.prepare('DELETE FROM telegram_log WHERE ts < ?'),
  };

  // ---- seed / reconcile ----------------------------------------------------
  /**
   * Idempotently reconcile family_health + plans from the watchlist config.
   * Descriptive fields (name/price/family/popular/watch) are refreshed; runtime
   * state (status/last_known/armed/timestamps) is preserved across reseeds.
   * @returns {{ families: number, plansInserted: number, plansUpdated: number }}
   */
  function seedFromWatchlist(watchlist) {
    const families = watchlist?.families ?? [];
    const plans = watchlist?.plans ?? [];
    let plansInserted = 0;
    let plansUpdated = 0;

    db.exec('BEGIN');
    try {
      for (const f of families) {
        stmt.famUpsert.run({ family: f.key, loc: f.loc, gen: f.gen, label: f.label ?? null });
      }
      for (const p of plans) {
        const row = {
          id: p.id,
          family: p.family,
          loc: p.loc,
          gen: p.gen,
          size: p.size,
          name: p.name,
          price: p.price,
          popular: bool(p.popular),
          watch: bool(p.watch ?? true),
        };
        if (stmt.planExists.get(p.id)) {
          stmt.planDescUpdate.run(row);
          plansUpdated += 1;
        } else {
          stmt.planInsert.run(row);
          plansInserted += 1;
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { families: families.length, plansInserted, plansUpdated };
  }

  // ---- plans ---------------------------------------------------------------
  const getPlan = (id) => stmt.planGet.get(id) ?? null;
  const allPlans = () => stmt.planAll.all();
  const plansByFamily = (family) => stmt.planByFamily.all(family);

  /** Update a plan's runtime state (display status + edge basis). */
  function setPlanState(id, { status, lastKnown, armed, lastChecked, lastChange, pidCache } = {}) {
    const cur = getPlan(id);
    if (!cur) throw new Error(`unknown plan "${id}"`);
    stmt.planStateUpdate.run({
      id,
      status: status ?? cur.status,
      lastKnown: lastKnown ?? cur.last_known,
      armed: armed === undefined ? cur.armed : bool(armed),
      lastChecked: lastChecked ?? cur.last_checked,
      lastChange: lastChange ?? cur.last_change,
      pidCache: pidCache ?? cur.pid_cache,
    });
    return getPlan(id);
  }

  // ---- transitions ---------------------------------------------------------
  function recordTransition({ planId, from, to, ts = Date.now(), durationInStock = null }) {
    stmt.transInsert.run({ planId, from, to, ts, durationInStock });
  }
  const transitionsForPlan = (planId, limit = 50) => stmt.transByPlan.all(planId, limit);
  const recentTransitions = (limit = 50) => stmt.transRecent.all(limit);

  // ---- telegram log --------------------------------------------------------
  function logTelegram({
    planId = null,
    ts = Date.now(),
    deepLink = null,
    message = null,
    sentOk = false,
    attempts = 0,
    lastError = null,
    sentTs = null,
  }) {
    const res = stmt.tgInsert.run({
      planId,
      ts,
      deepLink,
      message,
      sentOk: bool(sentOk),
      attempts,
      lastError,
      sentTs,
    });
    return res.lastInsertRowid;
  }
  const recentTelegram = (limit = 50) => stmt.tgRecent.all(limit);

  // ---- family health -------------------------------------------------------
  function setFamilyHealth(
    family,
    { lastPollTs, backoffLevel, lastOutcome, chromeState, blind, blindReasons, blindSince } = {},
  ) {
    const cur = stmt.famGet.get(family);
    if (!cur) throw new Error(`unknown family "${family}"`);
    stmt.famHealthSet.run({
      family,
      lastPollTs: lastPollTs ?? cur.last_poll_ts,
      backoffLevel: backoffLevel === undefined ? cur.backoff_level : backoffLevel,
      lastOutcome: lastOutcome ?? cur.last_outcome,
      chromeState: chromeState ?? cur.chrome_state,
      // blind fields update as a unit: blindReasons/blindSince may be null on
      // purpose (recovery), so `blind === undefined` decides preserve-vs-write.
      blind: blind === undefined ? cur.blind : bool(blind),
      blindReasons: blind === undefined ? cur.blind_reasons : (blindReasons ?? null),
      blindSince: blind === undefined ? cur.blind_since : (blindSince ?? null),
    });
    return stmt.famGet.get(family);
  }
  const getFamilyHealth = (family) => stmt.famGet.get(family) ?? null;
  const allFamilyHealth = () => stmt.famAll.all();

  // ---- heartbeat -----------------------------------------------------------
  function touchHeartbeat({ tickTs = Date.now(), chromeSession = null } = {}) {
    const cur = stmt.hbGet.get();
    stmt.hbUpsert.run({
      tickTs,
      uptimeStarted: cur?.uptime_started ?? tickTs,
      chromeSession,
    });
    return stmt.hbGet.get();
  }
  const getHeartbeat = () => stmt.hbGet.get() ?? null;

  // ---- retention -----------------------------------------------------------
  /** Prune append-only history older than `days` (default 90), then VACUUM. */
  function prune({ days = 90, now = Date.now(), vacuum = true } = {}) {
    const cutoff = now - days * DAY_MS;
    const transitions = stmt.pruneTrans.run(cutoff).changes;
    const telegram = stmt.pruneTg.run(cutoff).changes;
    if (vacuum) db.exec('VACUUM');
    return { transitions, telegram, cutoff };
  }

  return {
    db,
    seedFromWatchlist,
    getPlan,
    allPlans,
    plansByFamily,
    setPlanState,
    recordTransition,
    transitionsForPlan,
    recentTransitions,
    logTelegram,
    recentTelegram,
    setFamilyHealth,
    getFamilyHealth,
    allFamilyHealth,
    touchHeartbeat,
    getHeartbeat,
    prune,
    close: () => db.close(),
  };
}
