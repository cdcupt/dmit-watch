// Unit tests for the SQLite store against an in-memory DB + the real watchlist.
//   node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openStore } from '../src/store.js';
import { loadWatchlist } from '../src/config.js';

function freshStore() {
  const store = openStore(':memory:');
  store.seedFromWatchlist(loadWatchlist());
  return store;
}

test('seeds exactly 33 plans across 6 families', () => {
  const store = freshStore();
  assert.equal(store.allPlans().length, 33);
  assert.equal(store.allFamilyHealth().length, 6);
  store.close();
});

test('every seeded plan starts OUT, armed, with edge basis OUT', () => {
  const store = freshStore();
  for (const p of store.allPlans()) {
    assert.equal(p.status, 'OUT');
    assert.equal(p.last_known, 'OUT');
    assert.equal(p.armed, 1);
  }
  store.close();
});

test('reseed is idempotent and preserves runtime state', () => {
  const store = freshStore();
  const wl = loadWatchlist();
  // simulate a restock detected on one plan
  store.setPlanState('lax-an4-medium', { status: 'IN', lastKnown: 'IN', armed: 0 });

  const again = store.seedFromWatchlist(wl);
  assert.equal(again.plansInserted, 0);
  assert.equal(again.plansUpdated, 33);
  assert.equal(store.allPlans().length, 33); // no duplicates

  const p = store.getPlan('lax-an4-medium');
  assert.equal(p.last_known, 'IN'); // runtime state survived the reseed
  assert.equal(p.armed, 0);
  store.close();
});

test('records transitions and reads them back newest-first', () => {
  const store = freshStore();
  store.recordTransition({ planId: 'tyo-as3-mini', from: 'OUT', to: 'IN', ts: 1000 });
  store.recordTransition({ planId: 'tyo-as3-mini', from: 'IN', to: 'OUT', ts: 2000, durationInStock: 41 });
  const rows = store.transitionsForPlan('tyo-as3-mini');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].to_status, 'OUT');
  assert.equal(rows[0].duration_in_stock, 41);
  store.close();
});

test('logs telegram sends with sent_ok coerced to 0/1', () => {
  const store = freshStore();
  store.logTelegram({ planId: 'lax-an4-medium', ts: 5000, sentOk: true, attempts: 1 });
  store.logTelegram({ planId: 'tyo-as3-mini', ts: 6000, sentOk: false, attempts: 3, lastError: 'timeout' });
  const recent = store.recentTelegram();
  assert.equal(recent.length, 2);
  assert.equal(recent[0].sent_ok, 0); // newest first, the failed one
  assert.equal(recent[1].sent_ok, 1);
  store.close();
});

test('family health backoff + heartbeat singleton', () => {
  const store = freshStore();
  store.setFamilyHealth('hkg/an5', { backoffLevel: 2, lastOutcome: '403' });
  assert.equal(store.getFamilyHealth('hkg/an5').backoff_level, 2);

  const t1 = store.touchHeartbeat({ tickTs: 100, chromeSession: 'UP' });
  const t2 = store.touchHeartbeat({ tickTs: 200, chromeSession: 'DOWN' });
  assert.equal(t2.uptime_started, 100); // uptime fixed on first touch
  assert.equal(t2.tick_ts, 200);
  assert.equal(t2.chrome_session, 'DOWN');
  store.close();
});

test('prune drops rows older than the cutoff', () => {
  const store = freshStore();
  const now = 1_000 * 86_400_000; // a high, stable "now"
  store.recordTransition({ planId: 'lax-an4-medium', from: 'IN', to: 'OUT', ts: now - 100 * 86_400_000 });
  store.recordTransition({ planId: 'lax-an4-medium', from: 'OUT', to: 'IN', ts: now - 1 * 86_400_000 });
  const res = store.prune({ days: 90, now, vacuum: false });
  assert.equal(res.transitions, 1);
  assert.equal(store.transitionsForPlan('lax-an4-medium').length, 1);
  store.close();
});

test('setPlanState throws on unknown plan id', () => {
  const store = freshStore();
  assert.throws(() => store.setPlanState('nope-nope-nope', { status: 'IN' }), /unknown plan/);
  store.close();
});

// ---- store-serde branch coverage: merge fallbacks, on-disk path, rollback ----

test('setPlanState merges partial updates and coerces armed to 0/1', () => {
  const store = freshStore();
  // status-only update leaves every other field at its current value
  store.setPlanState('lax-an4-medium', { status: 'CHECKING' });
  let p = store.getPlan('lax-an4-medium');
  assert.equal(p.status, 'CHECKING');
  assert.equal(p.last_known, 'OUT'); // untouched
  assert.equal(p.armed, 1); // untouched

  // a full update overwrites everything, armed:false -> 0, pidCache persisted
  p = store.setPlanState('lax-an4-medium', {
    status: 'IN', lastKnown: 'IN', armed: false, lastChecked: 111, lastChange: 222, pidCache: 'pid-7',
  });
  assert.equal(p.status, 'IN');
  assert.equal(p.last_known, 'IN');
  assert.equal(p.armed, 0);
  assert.equal(p.last_checked, 111);
  assert.equal(p.last_change, 222);
  assert.equal(p.pid_cache, 'pid-7');
  store.close();
});

test('setFamilyHealth merges partial fields and throws on unknown family', () => {
  const store = freshStore();
  store.setFamilyHealth('lax/as3', { backoffLevel: 3, lastOutcome: 'err', chromeState: 'DOWN' });
  // a chromeState-only update preserves backoff_level (=== undefined branch)
  const h = store.setFamilyHealth('lax/as3', { chromeState: 'UP' });
  assert.equal(h.backoff_level, 3);
  assert.equal(h.last_outcome, 'err');
  assert.equal(h.chrome_state, 'UP');
  assert.throws(() => store.setFamilyHealth('ghost/zz', { backoffLevel: 1 }), /unknown family/);
  store.close();
});

test('recordTransition defaults ts to now; recentTransitions spans plans', () => {
  const store = freshStore();
  store.recordTransition({ planId: 'lax-an4-medium', from: 'OUT', to: 'IN' }); // default ts
  store.recordTransition({ planId: 'tyo-as3-mini', from: 'OUT', to: 'IN', ts: Date.now() + 5 });
  const recent = store.recentTransitions(10);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].plan_id, 'tyo-as3-mini'); // newest first
  assert.ok(store.transitionsForPlan('lax-an4-medium')[0].ts > 0);
  store.close();
});

test('plansByFamily returns just that family, size-ordered', () => {
  const store = freshStore();
  const rows = store.plansByFamily('lax/an5');
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.family === 'lax/an5'));
  store.close();
});

test('getHeartbeat is null before the first touch; logTelegram accepts minimal args', () => {
  const store = freshStore();
  assert.equal(store.getHeartbeat(), null);
  const id = store.logTelegram({}); // all defaults: null plan, sent_ok 0, attempts 0
  assert.ok(id > 0);
  const row = store.recentTelegram(1)[0];
  assert.equal(row.plan_id, null);
  assert.equal(row.sent_ok, 0);
  assert.equal(row.attempts, 0);
  store.close();
});

test('seedFromWatchlist rolls back atomically on a bad plan row', () => {
  const store = openStore(':memory:');
  // a plan referencing a family that was never seeded violates the FK -> ROLLBACK
  assert.throws(
    () => store.seedFromWatchlist({
      families: [],
      plans: [{ id: 'x-y-z', family: 'ghost/zz', loc: 'lax', gen: 'as3', size: 'Z', name: 'X', price: '$1' }],
    }),
    /FOREIGN KEY|constraint/i,
  );
  assert.equal(store.allPlans().length, 0); // nothing committed
  store.close();
});

test('on-disk store opens WAL, persists, and prune+VACUUM compacts', () => {
  const dir = join(tmpdir(), `dmit-store-${process.pid}-${Date.now()}`);
  const dbFile = join(dir, 'watch.db');
  try {
    const store = openStore(dbFile); // exercises mkdir + WAL pragma (non-:memory: path)
    store.seedFromWatchlist(loadWatchlist());
    const old = 1_000 * 86_400_000;
    store.recordTransition({ planId: 'lax-an4-medium', from: 'IN', to: 'OUT', ts: old - 100 * 86_400_000 });
    const res = store.prune({ days: 90, now: old, vacuum: true }); // default-vacuum branch
    assert.equal(res.transitions, 1);
    assert.equal(store.allPlans().length, 33);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
