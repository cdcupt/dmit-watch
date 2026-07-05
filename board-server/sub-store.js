// Subscriber store for the public board (round-2 TECH §B1/§B2): three tables in
// /data/board.db beside snapshot.json, opened with the same node:sqlite
// DatabaseSync idioms as src/store.js (WAL, prepared-statement map, PRAGMA
// table_info additive migrations, BEGIN/COMMIT/ROLLBACK) plus
// PRAGMA temp_store=MEMORY so SQLite's scratch space never targets the
// read-only container's unwritable /tmp. The DB file is chmod'd 0600-class.
//
//   subscribers  — cap enforced by the caller; lookup_hash = sha256(token:chatId)
//                  is auth + merge key; the bot token rests AES-256-GCM encrypted
//                  (fresh 12-byte IV per write, 16-byte tag appended to the
//                  ciphertext); chat_id stays plaintext by design (§B1 — a bare
//                  chat id is inert without the token).
//   plan_edges   — persisted armed state (D5): survives restarts, so a reboot
//                  never duplicates an alert. Cold-start seeding is FIRE-FREE:
//                  an absent row is seeded from the observation, never diffed
//                  (in→IN/disarmed, out→OUT/armed, unknown→no row) — a
//                  deliberate divergence from computePlanEdge's stored=null
//                  default, which would digest-blast every already-IN plan.
//   digest_queue — crash-safe outbox; created_at = the edge time; ON DELETE
//                  CASCADE so unsubscribing drops pending digests.
//
// The window-close transaction (closeDigestWindow) is the crash-safety
// keystone: disarm fired plans + enqueue per subscriber + prune, all in ONE
// BEGIN…COMMIT — a crash can never disarm without enqueueing (swallowed alert)
// nor enqueue without disarming (double card). Auth NEVER decrypts: lookup /
// update / delete resolve rows by lookup_hash only; decryption happens at send
// time alone (the dispatcher).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STOCK, computePlanEdge } from './edge-detect.js';

const DAY_MS = 86_400_000; // digest_queue retention horizon (pruned at window close)
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export const SUBSCRIBER_CAP = 500; // orchestrator-pinned; checked on the INSERT path only

// Full current schema (fresh DBs); existing DBs are migrated additively below.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS subscribers (
  id           INTEGER PRIMARY KEY,
  lookup_hash  BLOB NOT NULL UNIQUE,
  token_ct     BLOB NOT NULL,
  token_iv     BLOB NOT NULL,
  chat_id      TEXT NOT NULL,
  plan_ids     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  disabled     INTEGER NOT NULL DEFAULT 0,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  last_ok_ts   INTEGER
);
CREATE TABLE IF NOT EXISTS plan_edges (
  plan_id      TEXT PRIMARY KEY,
  last_known   TEXT NOT NULL,
  armed        INTEGER NOT NULL,
  last_change  INTEGER
);
CREATE TABLE IF NOT EXISTS digest_queue (
  id             INTEGER PRIMARY KEY,
  subscriber_id  INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  plan_ids       TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  sent_ts        INTEGER,
  last_error     TEXT
);
`;

/** sha256("token:chatId") — the auth + merge key; never decrypts anything. */
export function lookupHash(token, chatId) {
  return createHash('sha256').update(`${token}:${chatId}`).digest();
}

/**
 * Open (creating if needed) the subscription store.
 * @param {string} dbFile ':memory:' honored (the src/store.js test idiom)
 * @param {object} opts
 * @param {Buffer|string} opts.tokenKey 32-byte AES-256-GCM key (64 hex chars ok)
 */
export function openSubStore(dbFile, { tokenKey } = {}) {
  const key = typeof tokenKey === 'string' ? Buffer.from(tokenKey, 'hex') : tokenKey;
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('openSubStore: tokenKey must be a 32-byte key (64 hex chars)');
  }
  if (dbFile !== ':memory:') mkdirSync(dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  if (dbFile !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA temp_store = MEMORY;'); // read_only container: /tmp is unwritable (§B5)
  db.exec('PRAGMA foreign_keys = ON;'); // ON DELETE CASCADE depends on it
  db.exec(SCHEMA_SQL);
  if (dbFile !== ':memory:') chmodSync(dbFile, 0o600); // group/other: no access (AUD-R5)

  // Additive migrations (the src/store.js PRAGMA table_info idiom): columns
  // added after first ship are back-filled here; never a destructive rebuild.
  const MIGRATIONS = [
    ['subscribers', 'last_ok_ts', 'ALTER TABLE subscribers ADD COLUMN last_ok_ts INTEGER'],
    ['digest_queue', 'last_error', 'ALTER TABLE digest_queue ADD COLUMN last_error TEXT'],
  ];
  for (const [table, col, sql] of MIGRATIONS) {
    const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (!cols.has(col)) db.exec(sql);
  }

  // ---- prepared statements ---------------------------------------------------
  const stmt = {
    subByHash: db.prepare('SELECT * FROM subscribers WHERE lookup_hash = ?'),
    subById: db.prepare('SELECT * FROM subscribers WHERE id = ?'),
    subCount: db.prepare('SELECT COUNT(*) AS n FROM subscribers'),
    subInsert: db.prepare(`
      INSERT INTO subscribers (lookup_hash, token_ct, token_iv, chat_id, plan_ids, created_at, disabled, fail_count)
      VALUES (:lookupHash, :tokenCt, :tokenIv, :chatId, :planIds, :createdAt, 0, 0)`),
    subUpdate: db.prepare(`
      UPDATE subscribers
         SET token_ct = :tokenCt, token_iv = :tokenIv, plan_ids = :planIds, disabled = 0, fail_count = 0
       WHERE id = :id`),
    subDelete: db.prepare('DELETE FROM subscribers WHERE id = ?'),
    subDisable: db.prepare('UPDATE subscribers SET disabled = 1 WHERE id = ?'),
    subSendOk: db.prepare('UPDATE subscribers SET fail_count = 0, last_ok_ts = ? WHERE id = ?'),
    subSendFail: db.prepare('UPDATE subscribers SET fail_count = fail_count + 1 WHERE id = ?'),
    subEnabled: db.prepare('SELECT id, plan_ids FROM subscribers WHERE disabled = 0'),

    edgeGet: db.prepare('SELECT * FROM plan_edges WHERE plan_id = ?'),
    edgeSeed: db.prepare(`
      INSERT INTO plan_edges (plan_id, last_known, armed, last_change)
      VALUES (:planId, :lastKnown, :armed, :lastChange)`),
    edgeSet: db.prepare(`
      UPDATE plan_edges SET last_known = :lastKnown, armed = :armed, last_change = :lastChange
       WHERE plan_id = :planId`),
    edgeDisarm: db.prepare(`
      UPDATE plan_edges SET last_known = 'IN', armed = 0, last_change = :lastChange
       WHERE plan_id = :planId`),

    queueInsert: db.prepare(`
      INSERT INTO digest_queue (subscriber_id, plan_ids, created_at, attempts)
      VALUES (:subscriberId, :planIds, :createdAt, 0)`),
    queueUnsent: db.prepare(`
      SELECT q.id, q.subscriber_id, q.plan_ids, q.created_at, q.attempts,
             s.chat_id, s.token_ct, s.token_iv, s.disabled, s.fail_count
        FROM digest_queue q JOIN subscribers s ON s.id = q.subscriber_id
       WHERE q.sent_ts IS NULL AND (q.last_error IS NULL OR q.last_error <> 'expired')
       ORDER BY q.id`),
    queueGet: db.prepare('SELECT * FROM digest_queue WHERE id = ?'),
    queueAll: db.prepare('SELECT * FROM digest_queue ORDER BY id'),
    queueSent: db.prepare('UPDATE digest_queue SET sent_ts = :sentTs, attempts = :attempts WHERE id = :id'),
    queueError: db.prepare('UPDATE digest_queue SET attempts = :attempts, last_error = :lastError WHERE id = :id'),
    queuePrune: db.prepare('DELETE FROM digest_queue WHERE created_at < ?'),
  };

  // ---- token crypto (AES-256-GCM; decrypt is SEND-TIME ONLY) -----------------
  function encryptToken(token) {
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { ct, iv };
  }

  /** Decrypt a subscriber row's token. THROWS on GCM auth failure (tamper/rotated key). */
  function decryptToken(row) {
    const ct = Buffer.from(row.token_ct);
    const iv = Buffer.from(row.token_iv);
    const tag = ct.subarray(ct.length - GCM_TAG_BYTES);
    const body = ct.subarray(0, ct.length - GCM_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }

  // ---- subscribers -------------------------------------------------------------
  const parseRow = (row) => (row ? { ...row, planIds: JSON.parse(row.plan_ids) } : null);

  const findSubscriber = (token, chatId) => parseRow(stmt.subByHash.get(lookupHash(token, chatId)));
  const getSubscriber = (id) => parseRow(stmt.subById.get(id));
  const subscriberCount = () => Number(stmt.subCount.get().n);

  /** Insert a brand-new subscriber (the cap is the CALLER's insert-path check). */
  function createSubscriber({ token, chatId, planIds, now = Date.now() }) {
    const { ct, iv } = encryptToken(token);
    stmt.subInsert.run({
      lookupHash: lookupHash(token, chatId),
      tokenCt: ct,
      tokenIv: iv,
      chatId: String(chatId),
      planIds: JSON.stringify(planIds),
      createdAt: now,
    });
    return findSubscriber(token, chatId);
  }

  /**
   * Replace a row's plan list + re-encrypt the token under the current key with
   * a fresh IV; resets disabled/fail_count (every stored row proved delivery at
   * its last mutation — the §B1 key-rotation heal path).
   */
  function updateSubscriber(id, { token, planIds }) {
    const { ct, iv } = encryptToken(token);
    stmt.subUpdate.run({ id, tokenCt: ct, tokenIv: iv, planIds: JSON.stringify(planIds) });
    return getSubscriber(id);
  }

  const deleteSubscriber = (id) => stmt.subDelete.run(id).changes > 0;
  const disableSubscriber = (id) => stmt.subDisable.run(id);
  const recordSendOk = (id, ts) => stmt.subSendOk.run(ts, id);
  /** Bump consecutive-exhausted-dispatch count; returns the new value. */
  function recordSendFail(id) {
    stmt.subSendFail.run(id);
    return stmt.subById.get(id)?.fail_count ?? 0;
  }

  // ---- plan_edges: observation policy (§B2, push-time, sync, network-free) ----
  const getEdge = (planId) => stmt.edgeGet.get(planId) ?? null;

  /**
   * Apply one wire observation to a plan's persisted edge state.
   * Absent row → SEED fire-free (in→IN/disarmed, out→OUT/armed, unknown→no
   * row); UNKNOWN holds position (no fire, no rearm, no write — R7); a
   * confirmed OUT re-arms and persists NOW; an armed OUT→IN FIRES but its
   * disarm is NOT persisted here — that waits for the window-close transaction.
   * @param {string} planId
   * @param {'IN'|'OUT'|'UNKNOWN'} stock mapped wire status (edge-detect wireToStock)
   * @returns {{ fire: boolean, stock: string }}
   */
  function observePlan(planId, stock, now = Date.now()) {
    const stored = getEdge(planId);
    if (!stored) {
      if (stock === STOCK.IN) stmt.edgeSeed.run({ planId, lastKnown: 'IN', armed: 0, lastChange: now });
      else if (stock === STOCK.OUT) stmt.edgeSeed.run({ planId, lastKnown: 'OUT', armed: 1, lastChange: now });
      return { fire: false, stock }; // seeding NEVER fires; unknown seeds no row
    }
    if (stock === STOCK.UNKNOWN) return { fire: false, stock };
    const edge = computePlanEdge({ stock, stored, now });
    if (edge.fire) return { fire: true, stock }; // disarm deferred to closeDigestWindow
    const armed = edge.newArmed ? 1 : 0;
    if (edge.newLastKnown !== stored.last_known || armed !== stored.armed || edge.lastChange !== stored.last_change) {
      stmt.edgeSet.run({ planId, lastKnown: edge.newLastKnown, armed, lastChange: edge.lastChange });
    }
    return { fire: false, stock };
  }

  // ---- the window-close transaction (crash-safety keystone) -------------------
  /**
   * ONE transaction: ① disarm every fired plan (armed=0, last_known=IN,
   * last_change = the edge time) ② one digest_queue row per ENABLED subscriber
   * whose plan list intersects the fired set (empty intersection = no row)
   * ③ prune queue rows older than 24 h. Throws on failure AFTER rolling back —
   * plans stay armed and nothing is enqueued (never a half-closed window).
   * @returns {{ enqueued: number }}
   */
  function closeDigestWindow({ firedPlanIds, edgeTime, now = Date.now() }) {
    db.exec('BEGIN');
    try {
      for (const planId of firedPlanIds) stmt.edgeDisarm.run({ planId, lastChange: edgeTime });
      let enqueued = 0;
      for (const sub of stmt.subEnabled.all()) {
        const mine = firedPlanIds.filter((id) => JSON.parse(sub.plan_ids).includes(id));
        if (mine.length === 0) continue;
        stmt.queueInsert.run({ subscriberId: sub.id, planIds: JSON.stringify(mine), createdAt: edgeTime });
        enqueued += 1;
      }
      stmt.queuePrune.run(now - DAY_MS);
      db.exec('COMMIT');
      return { enqueued };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- digest queue ------------------------------------------------------------
  const unsentQueue = () => stmt.queueUnsent.all();
  const getQueueRow = (id) => stmt.queueGet.get(id) ?? null;
  const allQueueRows = () => stmt.queueAll.all();
  const markQueueSent = (id, sentTs, attempts) => stmt.queueSent.run({ id, sentTs, attempts });
  const markQueueError = (id, { attempts, lastError }) => stmt.queueError.run({ id, attempts, lastError });
  const markQueueExpired = (id, attempts = 0) => stmt.queueError.run({ id, attempts, lastError: 'expired' });

  return {
    db, // exposed for tests (seeding, poisoning, pragma checks) — never for routes
    encryptToken,
    decryptToken,
    findSubscriber,
    getSubscriber,
    subscriberCount,
    createSubscriber,
    updateSubscriber,
    deleteSubscriber,
    disableSubscriber,
    recordSendOk,
    recordSendFail,
    getEdge,
    observePlan,
    closeDigestWindow,
    unsentQueue,
    getQueueRow,
    allQueueRows,
    markQueueSent,
    markQueueError,
    markQueueExpired,
    close: () => db.close(),
  };
}
