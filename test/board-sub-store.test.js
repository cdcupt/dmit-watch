// Unit tests for board-server/edge-detect.js + board-server/sub-store.js
// (round-2 TECH §Q1.1 EDG-U*, §Q1.5 CRY-U*, §Q3.3 RO-I*): the copied edge
// engine's parity with the watcher's, cold-start fire-free seeding, the
// UNKNOWN-holds-position rule at the seeding layer, AES-256-GCM token crypto
// with hash-only auth, and the read_only-container persistence contract
// (pragmas, WAL siblings, 0600-class perms, :memory:, additive migration).
// Restart rows use two store instances on the same tmpdir file — the
// board-server.test.js:278 two-factory idiom.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { STOCK, computePlanEdge, wireToStock } from '../board-server/edge-detect.js';
import { computePlanEdge as watcherComputePlanEdge } from '../src/detect.js';
import { lookupHash, openSubStore } from '../board-server/sub-store.js';

const TOKEN_KEY = '11'.repeat(32); // built at runtime — never a hex-literal of key length (SEC-6)
const KEY_B = '22'.repeat(32);
const SUB_TOKEN = '8000000001:TESTSENTINELTOKENxxxxxxxxxxxxxxxx'; // §Q0 sentinel convention
const CHAT_ID = '4400000042';
const T0 = Date.parse('2026-07-05T06:00:00.000Z');

const mem = () => openSubStore(':memory:', { tokenKey: TOKEN_KEY });
// node:sqlite rows are null-prototype objects — spread to plain for deepEqual vs literals.
const plain = (row) => (row == null ? row : { ...row });
const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'dmit-substore-')), 'board.db');

// ---- EDG: the copied edge engine + fire-free seeding --------------------------

test('EDG-U1: copied computePlanEdge is byte-identical to src/detect.js across the full stored × observed matrix', () => {
  const storedVariants = [
    null,
    { last_known: 'IN', armed: 0, last_change: T0 - 5000 },
    { last_known: 'IN', armed: 1, last_change: T0 - 5000 },
    { last_known: 'OUT', armed: 0, last_change: T0 - 5000 },
    { last_known: 'OUT', armed: 1, last_change: T0 - 5000 },
    { last_known: 'OUT', armed: 1, last_change: null },
    { last_known: 'IN', armed: null, last_change: undefined },
  ];
  for (const stored of storedVariants) {
    for (const stock of [STOCK.IN, STOCK.OUT, STOCK.UNKNOWN]) {
      for (const cooldownMs of [0, 10_000]) {
        assert.deepEqual(
          computePlanEdge({ stock, stored, now: T0, cooldownMs }),
          watcherComputePlanEdge({ stock, stored, now: T0, cooldownMs }),
          `stored=${JSON.stringify(stored)} stock=${stock} cooldown=${cooldownMs}`,
        );
      }
    }
  }
});

test('wireToStock: in→IN, out→OUT, anything else→UNKNOWN', () => {
  assert.equal(wireToStock('in'), STOCK.IN);
  assert.equal(wireToStock('out'), STOCK.OUT);
  for (const v of ['checking', 'unknown', '', null, undefined, 42]) {
    assert.equal(wireToStock(v), STOCK.UNKNOWN, `wire status ${String(v)}`);
  }
});

test('EDG-U2: fresh DB + observed IN seeds (IN, disarmed) and NEVER fires — the cold-start gate', () => {
  const store = mem();
  const { fire } = store.observePlan('p1', STOCK.IN, T0);
  assert.equal(fire, false, 'seeding never fires (deliberate divergence from src/detect.js stored=null)');
  assert.deepEqual(plain(store.getEdge('p1')), { plan_id: 'p1', last_known: 'IN', armed: 0, last_change: T0 });
  assert.deepEqual(store.allQueueRows(), [], 'zero queue rows on a cold start');
  // The divergence, asserted explicitly: the raw engine WOULD fire here.
  assert.equal(computePlanEdge({ stock: STOCK.IN, stored: null, now: T0 }).fire, true);
  store.close();
});

test('EDG-U3: fresh DB + observed OUT seeds (OUT, armed) without firing — ready for its first real restock', () => {
  const store = mem();
  assert.equal(store.observePlan('p1', STOCK.OUT, T0).fire, false);
  assert.deepEqual(plain(store.getEdge('p1')), { plan_id: 'p1', last_known: 'OUT', armed: 1, last_change: T0 });
  store.close();
});

test('EDG-U4: fresh DB + UNKNOWN creates no row; a later IN then seeds fire-free (R7 at the seeding layer)', () => {
  const store = mem();
  assert.equal(store.observePlan('p1', STOCK.UNKNOWN, T0).fire, false);
  assert.equal(store.getEdge('p1'), null, 'unknown seeds no row — the plan holds until its first confirmed status');
  assert.equal(store.observePlan('p1', STOCK.IN, T0 + 1000).fire, false, 'still no fire when it resolves to IN');
  assert.equal(store.getEdge('p1').armed, 0);
  store.close();
});

test('EDG-U5: armed OUT→IN FIRES; disarm is NOT yet persisted; a second IN re-fires (window dedup absorbs it)', () => {
  const store = mem();
  store.observePlan('p1', STOCK.OUT, T0); // seed (OUT, armed)
  assert.equal(store.observePlan('p1', STOCK.IN, T0 + 1000).fire, true);
  // Disarm waits for the window-close transaction (§B2) — the row is untouched.
  assert.deepEqual(plain(store.getEdge('p1')), { plan_id: 'p1', last_known: 'OUT', armed: 1, last_change: T0 });
  assert.equal(store.observePlan('p1', STOCK.IN, T0 + 2000).fire, true, 're-fires into the Set — no timing hole');
  store.close();
});

test('EDG-U6: disarmed IN + observed IN → no fire, no write', () => {
  const store = mem();
  store.observePlan('p1', STOCK.IN, T0); // seed (IN, disarmed)
  const before = store.getEdge('p1');
  assert.equal(store.observePlan('p1', STOCK.IN, T0 + 9000).fire, false);
  assert.deepEqual(store.getEdge('p1'), before, 'stays disarmed — no repeat alerts while IN');
  store.close();
});

test('EDG-U7: confirmed OUT re-arms and persists NOW (level-triggered)', () => {
  const store = mem();
  store.observePlan('p1', STOCK.IN, T0);
  assert.equal(store.observePlan('p1', STOCK.OUT, T0 + 5000).fire, false);
  assert.deepEqual(plain(store.getEdge('p1')), { plan_id: 'p1', last_known: 'OUT', armed: 1, last_change: T0 + 5000 });
  store.close();
});

test('EDG-U8: UNKNOWN holds position from every prior state — no fire, no rearm, no write (R7)', () => {
  const priors = [
    ['in-disarmed', (s) => s.observePlan('p1', STOCK.IN, T0)],
    ['out-armed', (s) => s.observePlan('p1', STOCK.OUT, T0)],
    ['in-then-out', (s) => (s.observePlan('p1', STOCK.IN, T0), s.observePlan('p1', STOCK.OUT, T0 + 1))],
    ['out-then-in-disarmed', (s) => {
      s.observePlan('p1', STOCK.OUT, T0);
      s.closeDigestWindow({ firedPlanIds: ['p1'], edgeTime: T0 + 1, now: T0 + 1 }); // persist a disarm
    }],
  ];
  for (const [label, seed] of priors) {
    const store = mem();
    seed(store);
    const before = store.getEdge('p1');
    assert.equal(store.observePlan('p1', STOCK.UNKNOWN, T0 + 60_000).fire, false, label);
    assert.deepEqual(store.getEdge('p1'), before, `${label}: plan_edges byte-identical before/after`);
    store.close();
  }
});

test('EDG-U9: a gap/restart spanning OUT→IN still fires exactly once (two stores, same file)', () => {
  const file = tmpDb();
  const a = openSubStore(file, { tokenKey: TOKEN_KEY });
  a.observePlan('p1', STOCK.OUT, T0); // (OUT, armed) persisted
  a.close();
  const b = openSubStore(file, { tokenKey: TOKEN_KEY });
  assert.equal(b.observePlan('p1', STOCK.IN, T0 + 3_600_000).fire, true, 'first push after the gap fires');
  b.close();
});

test('EDG-U10: disarmed state survives a restart — no duplicate alert across reboots (D5)', () => {
  const file = tmpDb();
  const a = openSubStore(file, { tokenKey: TOKEN_KEY });
  a.observePlan('p1', STOCK.OUT, T0);
  a.observePlan('p1', STOCK.IN, T0 + 1000); // fire
  a.closeDigestWindow({ firedPlanIds: ['p1'], edgeTime: T0 + 1000, now: T0 + 1000 }); // disarm persisted
  a.close();
  const b = openSubStore(file, { tokenKey: TOKEN_KEY });
  assert.equal(b.observePlan('p1', STOCK.IN, T0 + 60_000).fire, false, 'still disarmed after reboot');
  b.close();
});

test('EDG-U11: a plan newly added to the watchlist seeds fire-free; existing rows untouched', () => {
  const store = mem();
  store.observePlan('old-out', STOCK.OUT, T0);
  store.observePlan('old-in', STOCK.IN, T0);
  const beforeOut = store.getEdge('old-out');
  const beforeIn = store.getEdge('old-in');
  // The watchlist grows: newcomers arrive in every state, none may fire.
  assert.equal(store.observePlan('new-in', STOCK.IN, T0 + 1000).fire, false);
  assert.equal(store.observePlan('new-out', STOCK.OUT, T0 + 1000).fire, false);
  assert.equal(store.observePlan('new-unknown', STOCK.UNKNOWN, T0 + 1000).fire, false);
  assert.deepEqual(plain(store.getEdge('new-in')), { plan_id: 'new-in', last_known: 'IN', armed: 0, last_change: T0 + 1000 });
  assert.deepEqual(plain(store.getEdge('new-out')), { plan_id: 'new-out', last_known: 'OUT', armed: 1, last_change: T0 + 1000 });
  assert.equal(store.getEdge('new-unknown'), null);
  assert.deepEqual(store.getEdge('old-out'), beforeOut);
  assert.deepEqual(store.getEdge('old-in'), beforeIn);
  assert.deepEqual(store.allQueueRows(), []);
  store.close();
});

// ---- CRY: token crypto + lookup_hash ------------------------------------------

test('CRY-U1: round-trip with a fresh 12-byte IV per write; ciphertext carries the 16-byte GCM tag', () => {
  const store = mem();
  const one = store.encryptToken(SUB_TOKEN);
  const two = store.encryptToken(SUB_TOKEN);
  assert.equal(one.iv.length, 12);
  assert.equal(one.ct.length, Buffer.byteLength(SUB_TOKEN) + 16, 'ciphertext‖16-byte tag');
  assert.notDeepEqual(one.iv, two.iv, 'fresh random IV per write');
  assert.notDeepEqual(one.ct, two.ct, 'same plaintext, different ciphertext');
  assert.equal(store.decryptToken({ token_ct: one.ct, token_iv: one.iv }), SUB_TOKEN);
  assert.equal(store.decryptToken({ token_ct: two.ct, token_iv: two.iv }), SUB_TOKEN);
  store.close();
});

test('CRY-U2: tamper detection — a flipped byte in ct or iv fails cleanly, never returns garbage', () => {
  const store = mem();
  const { ct, iv } = store.encryptToken(SUB_TOKEN);
  const badCt = Buffer.from(ct);
  badCt[0] ^= 0xff;
  assert.throws(() => store.decryptToken({ token_ct: badCt, token_iv: iv }), 'flipped ciphertext byte');
  const badIv = Buffer.from(iv);
  badIv[0] ^= 0xff;
  assert.throws(() => store.decryptToken({ token_ct: ct, token_iv: badIv }), 'flipped IV byte');
  store.close();
});

test('CRY-U3: key rotation — decrypt fails under the new key; an update re-encrypts and re-enables (the heal path)', () => {
  const file = tmpDb();
  const a = openSubStore(file, { tokenKey: TOKEN_KEY });
  const row = a.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['p1'], now: T0 });
  a.close();

  const b = openSubStore(file, { tokenKey: KEY_B }); // rotated key
  const stale = b.findSubscriber(SUB_TOKEN, CHAT_ID);
  assert.equal(stale.id, row.id, 'auth still resolves (hash-only)');
  assert.throws(() => b.decryptToken(stale), 'GCM auth fails under the rotated key');
  b.disableSubscriber(stale.id); // what the dispatcher does on decrypt failure (DSP-U10)
  // A manage-update re-proves delivery at the route layer, then re-encrypts here:
  const healed = b.updateSubscriber(stale.id, { token: SUB_TOKEN, planIds: ['p1', 'p2'] });
  assert.equal(healed.disabled, 0);
  assert.equal(healed.fail_count, 0);
  assert.equal(b.decryptToken(healed), SUB_TOKEN, 're-encrypted under the current key');
  b.close();
});

test('CRY-U4: auth never decrypts — lookup/update/delete resolve via lookup_hash even under a wrong key', () => {
  const file = tmpDb();
  const a = openSubStore(file, { tokenKey: TOKEN_KEY });
  a.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['p1'], now: T0 });
  a.close();
  const b = openSubStore(file, { tokenKey: KEY_B });
  const found = b.findSubscriber(SUB_TOKEN, CHAT_ID); // lookup auth
  assert.deepEqual(found.planIds, ['p1']);
  assert.deepEqual(Buffer.from(found.lookup_hash), lookupHash(SUB_TOKEN, CHAT_ID));
  const updated = b.updateSubscriber(found.id, { token: SUB_TOKEN, planIds: ['p2'] }); // update auth’d by the same hash
  assert.deepEqual(updated.planIds, ['p2']);
  assert.equal(b.deleteSubscriber(found.id), true); // delete auth
  assert.equal(b.findSubscriber(SUB_TOKEN, CHAT_ID), null);
  b.close();
});

test('CRY-U5: at-rest bytes — the token plaintext appears nowhere in the DB files; the chat id (deliberately plaintext) does', () => {
  const file = tmpDb();
  const store = openSubStore(file, { tokenKey: TOKEN_KEY });
  store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['p1'], now: T0 });
  let bytes = readFileSync(file, 'latin1');
  for (const sibling of [`${file}-wal`, `${file}-shm`]) {
    if (existsSync(sibling)) bytes += readFileSync(sibling, 'latin1');
  }
  assert.ok(!bytes.includes(SUB_TOKEN), 'token plaintext must never rest on disk');
  assert.ok(!bytes.includes('TESTSENTINEL'), 'no fragment of the token secret either');
  assert.ok(bytes.includes(CHAT_ID), 'chat_id is plaintext by design (§B1) — pinning the documented trade');
  store.close();
});

// ---- RO: read_only-container & persistence contract ----------------------------

test('RO-I1: pragmas as deployed — WAL, temp_store=MEMORY, foreign_keys=ON', () => {
  const file = tmpDb();
  const store = openSubStore(file, { tokenKey: TOKEN_KEY });
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(Number(store.db.prepare('PRAGMA temp_store').get().temp_store), 2, 'MEMORY — the read_only fix');
  assert.equal(Number(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1, 'CASCADE depends on it');
  store.close();
});

test('RO-I2: WAL siblings live beside board.db — the /data-not-/tmp layout compose depends on', () => {
  const file = tmpDb();
  const store = openSubStore(file, { tokenKey: TOKEN_KEY });
  store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['p1'], now: T0 });
  assert.ok(existsSync(`${file}-wal`), 'board.db-wal beside board.db');
  assert.ok(existsSync(`${file}-shm`), 'board.db-shm beside board.db');
  store.close();
});

test('RO-I3: 0600-class permissions — group/other have no access to board.db', () => {
  const file = tmpDb();
  const store = openSubStore(file, { tokenKey: TOKEN_KEY });
  assert.equal(statSync(file).mode & 0o077, 0, 'mode & 0o077 === 0');
  store.close();
});

test('RO-I4: restart survival across all three tables (two factory instances, same file)', () => {
  const file = tmpDb();
  const a = openSubStore(file, { tokenKey: TOKEN_KEY });
  a.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['p1', 'p2'], now: T0 });
  a.observePlan('p1', STOCK.OUT, T0);
  a.observePlan('p1', STOCK.IN, T0 + 1000); // fire
  a.closeDigestWindow({ firedPlanIds: ['p1'], edgeTime: T0 + 1000, now: T0 + 1000 }); // 1 unsent queue row
  a.close();

  const b = openSubStore(file, { tokenKey: TOKEN_KEY });
  assert.deepEqual(b.findSubscriber(SUB_TOKEN, CHAT_ID).planIds, ['p1', 'p2'], 'subscriber served after reboot');
  assert.deepEqual(plain(b.getEdge('p1')), { plan_id: 'p1', last_known: 'IN', armed: 0, last_change: T0 + 1000 });
  const unsent = b.unsentQueue();
  assert.equal(unsent.length, 1, 'the unsent queue row is there for the boot re-drain');
  assert.deepEqual(JSON.parse(unsent[0].plan_ids), ['p1']);
  b.close();
});

test('RO-I5: :memory: honored — full lifecycle with zero files created (the SUB_DB_FILE test seam)', () => {
  const store = mem();
  const row = store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['p1'], now: T0 });
  store.observePlan('p1', STOCK.OUT, T0);
  store.observePlan('p1', STOCK.IN, T0 + 1);
  assert.equal(store.closeDigestWindow({ firedPlanIds: ['p1'], edgeTime: T0 + 1, now: T0 + 1 }).enqueued, 1);
  store.markQueueSent(store.unsentQueue()[0].id, T0 + 2, 1);
  assert.equal(store.deleteSubscriber(row.id), true);
  assert.ok(!existsSync(':memory:'), 'no file materialized');
  store.close();
});

test('RO-I6: additive migration — a v1 DB missing late columns gains them; rows preserved, no rebuild', () => {
  const file = tmpDb();
  // Simulated v1 schema: subscribers without last_ok_ts, digest_queue without last_error.
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE subscribers (
      id INTEGER PRIMARY KEY, lookup_hash BLOB NOT NULL UNIQUE, token_ct BLOB NOT NULL,
      token_iv BLOB NOT NULL, chat_id TEXT NOT NULL, plan_ids TEXT NOT NULL,
      created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE plan_edges (plan_id TEXT PRIMARY KEY, last_known TEXT NOT NULL, armed INTEGER NOT NULL, last_change INTEGER);
    CREATE TABLE digest_queue (
      id INTEGER PRIMARY KEY, subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
      plan_ids TEXT NOT NULL, created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_ts INTEGER);
  `);
  raw
    .prepare('INSERT INTO subscribers (lookup_hash, token_ct, token_iv, chat_id, plan_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(lookupHash(SUB_TOKEN, CHAT_ID), Buffer.from('ct'), Buffer.from('iv'), CHAT_ID, '["p1"]', T0);
  raw.close();

  const store = openSubStore(file, { tokenKey: TOKEN_KEY });
  const cols = (table) => new Set(store.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  assert.ok(cols('subscribers').has('last_ok_ts'), 'subscribers.last_ok_ts added');
  assert.ok(cols('digest_queue').has('last_error'), 'digest_queue.last_error added');
  const row = store.findSubscriber(SUB_TOKEN, CHAT_ID);
  assert.deepEqual(row.planIds, ['p1'], 'existing row preserved through the migration');
  assert.equal(row.last_ok_ts, null);
  store.close();
});
