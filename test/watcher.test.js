// Integration tests for the watcher against an in-memory store + a fake page
// source (no Chrome). Verifies persistence, edge events, re-arm, and the
// blind-watcher net.  node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWatcher } from '../src/watcher.js';
import { openStore } from '../src/store.js';
import { loadWatchlist } from '../src/config.js';
import { readFixture, makeFixtureSource } from './helpers.js';

const FAM = 'lax/an5';

function setup(script) {
  const wl = loadWatchlist();
  const store = openStore(':memory:');
  store.seedFromWatchlist(wl);
  const watcher = createWatcher({ store, watchlist: wl, pageSource: makeFixtureSource(script) });
  return { wl, store, watcher };
}

test('all-OUT cycle: every plan stays OUT, no edges, family health ok', () => {
  const { store, watcher } = setup({ [FAM]: readFixture('all-out.txt') });
  return watcher.pollFamily(FAM).then((s) => {
    assert.equal(s.outcome, 'ok');
    assert.deepEqual(s.fired, []);
    assert.equal(store.getPlan('lax-an5-mini').status, 'OUT');
    assert.equal(store.getFamilyHealth(FAM).last_outcome, 'ok');
  });
});

test('restock: OUT->IN fires exactly one edge event, persists IN + transition, disarms', async () => {
  let page = readFixture('all-out.txt');
  const { store, watcher } = setup({ [FAM]: () => ({ ok: true, status: 200, pageText: page }) });
  const edges = [];
  watcher.on('edge', (e) => edges.push(e));

  await watcher.pollFamily(FAM); // all OUT
  page = readFixture('orderable.synthetic.txt'); // MINI restocks
  const s = await watcher.pollFamily(FAM);

  assert.deepEqual(s.fired, ['lax-an5-mini']);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].plan.id, 'lax-an5-mini');
  assert.ok(edges[0].deepLink.includes('generation=an5'));

  const mini = store.getPlan('lax-an5-mini');
  assert.equal(mini.status, 'IN');
  assert.equal(mini.last_known, 'IN');
  assert.equal(mini.armed, 0);
  assert.equal(store.transitionsForPlan('lax-an5-mini').length, 1);

  // still IN next cycle -> no second alert
  const s3 = await watcher.pollFamily(FAM);
  assert.deepEqual(s3.fired, []);
  assert.equal(edges.length, 1);
});

test('re-arm: IN->OUT emits rearm, records duration, re-arms the plan', async () => {
  let page = readFixture('all-out.txt');
  const { store, watcher } = setup({ [FAM]: () => ({ ok: true, status: 200, pageText: page }) });
  const rearms = [];
  watcher.on('rearm', (e) => rearms.push(e));

  await watcher.pollFamily(FAM);
  page = readFixture('orderable.synthetic.txt');
  await watcher.pollFamily(FAM); // IN (disarmed)
  page = readFixture('all-out.txt');
  await watcher.pollFamily(FAM); // back to OUT -> re-arm

  assert.equal(rearms.length, 1);
  assert.equal(rearms[0].plan.id, 'lax-an5-mini');
  const mini = store.getPlan('lax-an5-mini');
  assert.equal(mini.armed, 1);
  assert.equal(mini.last_known, 'OUT');
  // one OUT->IN + one IN->OUT recorded
  assert.equal(store.transitionsForPlan('lax-an5-mini').length, 2);
});

test('UNKNOWN read never flips a plan to IN and never re-arms', async () => {
  let read = { ok: true, status: 200, pageText: readFixture('all-out.txt') };
  const { store, watcher } = setup({ [FAM]: () => read });
  await watcher.pollFamily(FAM); // OUT, armed
  read = { ok: false, status: 403, pageText: '', chromeState: 'DOWN' }; // blocked
  const s = await watcher.pollFamily(FAM);

  assert.deepEqual(s.fired, []);
  assert.equal(store.getPlan('lax-an5-mini').status, 'UNKNOWN');
  assert.equal(store.getPlan('lax-an5-mini').last_known, 'OUT'); // edge basis untouched
  assert.equal(store.getPlan('lax-an5-mini').armed, 1); // still armed
  assert.equal(store.getFamilyHealth(FAM).last_outcome, '403');
});

test('blind-watcher: persistent CF challenge fires one blind event at N cycles', async () => {
  const { wl, watcher } = setup({ [FAM]: () => ({ ok: true, status: 200, pageText: readFixture('cf-challenge.txt') }) });
  const blinds = [];
  watcher.on('blind', (e) => blinds.push(e));

  const N = wl.settings.blindCycles;
  for (let i = 1; i <= N; i++) await watcher.pollFamily(FAM);

  assert.equal(blinds.length, 1); // fires once on entry, not every cycle
  assert.equal(blinds[0].family.key, FAM);
  assert.ok(blinds[0].reasons.length > 0);
});

test('blind-watcher clears when the cart comes back', async () => {
  let page = readFixture('cf-challenge.txt');
  const { wl, watcher } = setup({ [FAM]: () => ({ ok: true, status: 200, pageText: page }) });
  const events = [];
  watcher.on('blind', () => events.push('blind'));
  watcher.on('blind:cleared', () => events.push('cleared'));

  for (let i = 0; i < wl.settings.blindCycles; i++) await watcher.pollFamily(FAM);
  page = readFixture('all-out.txt'); // recover
  await watcher.pollFamily(FAM);

  assert.deepEqual(events, ['blind', 'cleared']);
});

test('backoff level rises on repeated failures and resets on a clean read', async () => {
  let read = { ok: false, status: 403, pageText: '' };
  const { store, watcher } = setup({ [FAM]: () => read });
  await watcher.pollFamily(FAM);
  await watcher.pollFamily(FAM);
  assert.ok(store.getFamilyHealth(FAM).backoff_level >= 2);
  read = { ok: true, status: 200, pageText: readFixture('all-out.txt') };
  await watcher.pollFamily(FAM);
  assert.equal(store.getFamilyHealth(FAM).backoff_level, 0);
});

// ---- HIGH 2: reads are serialized (no concurrent CDP navigations) ----------

test('concurrent polls never overlap their reads (global poll lock)', async () => {
  const wl = loadWatchlist();
  const store = openStore(':memory:');
  store.seedFromWatchlist(wl);

  let active = 0;
  let maxActive = 0;
  // A page source whose read has a real suspension point between enter and exit —
  // without the watcher's mutex two concurrent reads WOULD overlap (maxActive=2).
  const source = {
    async readFamily() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return { ok: true, status: 200, pageText: readFixture('all-out.txt'), chromeState: 'UP' };
    },
    async close() {},
  };
  const watcher = createWatcher({ store, watchlist: wl, pageSource: source });

  const fams = wl.families.slice(0, 3).map((f) => f.key);
  await Promise.all(fams.map((k) => watcher.pollFamily(k)));

  assert.equal(maxActive, 1, 'two reads overlapped — the poll lock did not serialize navigations');
});

// ---- HIGH 3: blind alert re-notifies on a throttled interval ----------------

test('blind re-notify: a persistent block re-emits on the interval, not every cycle', async () => {
  const wl = loadWatchlist();
  const store = openStore(':memory:');
  store.seedFromWatchlist(wl);

  let clock = 1_000_000;
  const watcher = createWatcher({
    store,
    watchlist: wl,
    pageSource: makeFixtureSource({ [FAM]: () => ({ ok: true, status: 200, pageText: readFixture('cf-challenge.txt') }) }),
    now: () => clock,
  });
  const renotifyMs = (wl.settings.blindRenotifySec ?? 3600) * 1000;
  let blinds = 0;
  watcher.on('blind', () => (blinds += 1));

  // Trip the blind net: blindCycles consecutive blocked reads -> one emit on entry.
  for (let i = 0; i < wl.settings.blindCycles; i++) {
    clock += 75_000;
    await watcher.pollFamily(FAM);
  }
  assert.equal(blinds, 1, 'blind should fire once on entry');

  // Keep polling while blind but INSIDE the re-notify window -> no spam.
  clock += 75_000;
  await watcher.pollFamily(FAM);
  clock += 75_000;
  await watcher.pollFamily(FAM);
  assert.equal(blinds, 1, 'must not re-emit every cycle');

  // Cross the re-notify interval -> exactly one more reminder.
  clock += renotifyMs;
  await watcher.pollFamily(FAM);
  assert.equal(blinds, 2, 'should re-emit once past blindRenotifySec');
});

test('blind re-notify resets on recovery: the next blind re-emits immediately', async () => {
  const wl = loadWatchlist();
  const store = openStore(':memory:');
  store.seedFromWatchlist(wl);

  let clock = 1_000_000;
  let page = readFixture('cf-challenge.txt');
  const watcher = createWatcher({
    store,
    watchlist: wl,
    pageSource: makeFixtureSource({ [FAM]: () => ({ ok: true, status: 200, pageText: page }) }),
    now: () => clock,
  });
  const events = [];
  watcher.on('blind', () => events.push('blind'));
  watcher.on('blind:cleared', () => events.push('cleared'));

  for (let i = 0; i < wl.settings.blindCycles; i++) {
    clock += 75_000;
    await watcher.pollFamily(FAM);
  }
  page = readFixture('all-out.txt'); // recover
  clock += 75_000;
  await watcher.pollFamily(FAM);
  // go blind again, well within the same re-notify window as the first entry
  page = readFixture('cf-challenge.txt');
  for (let i = 0; i < wl.settings.blindCycles; i++) {
    clock += 75_000;
    await watcher.pollFamily(FAM);
  }
  assert.deepEqual(events, ['blind', 'cleared', 'blind']);
});

// ---- global control group + blind escalation (2026-07-03 mass-restock fix) --

/** Minimal trustworthy cart render for any family (markers + names + prices). */
function familyPage(family, plans, { inStock = new Set() } = {}) {
  const lines = [`Configure Your Premium Network — ${family.genLabel} Instance Scale`];
  for (const p of plans) {
    lines.push(p.name);
    if (!inStock.has(p.id)) lines.push('Out of Stock');
    lines.push(`${p.price} USD / Monthly`);
  }
  lines.push('TOTAL DUE TODAY $0.00');
  return lines.join('\n');
}

function familyFixtures(wl, key, opts) {
  const family = wl.families.find((f) => f.key === key);
  const plans = wl.plans.filter((p) => p.family === key);
  return familyPage(family, plans, opts);
}

test('mass restock: another family\'s sold-out wall is the control — every plan fires', async () => {
  const wl = loadWatchlist();
  const hkIds = new Set(wl.plans.filter((p) => p.family === 'hkg/as3').map((p) => p.id));
  const { store, watcher } = setup({
    'lax/as3': familyFixtures(wl, 'lax/as3'), // all 6 OUT — the control wall
    'hkg/as3': familyFixtures(wl, 'hkg/as3', { inStock: hkIds }), // full restock
  });
  const edges = [];
  watcher.on('edge', (e) => edges.push(e));

  // Restocked family polled FIRST: no control evidence yet → UNKNOWN, no false fire.
  const s0 = await watcher.pollFamily('hkg/as3');
  assert.deepEqual(s0.fired, []);
  assert.ok(Object.values(s0.statuses).every((st) => st === 'UNKNOWN'));

  // The LAX sold-out wall proves the reader parses the current layout…
  await watcher.pollFamily('lax/as3');

  // …so the next HKG poll promotes all 5 cards to IN and fires every edge.
  const s1 = await watcher.pollFamily('hkg/as3');
  assert.equal(s1.fired.length, 5);
  assert.equal(edges.length, 5);
  assert.equal(store.getPlan('hkg-as3-tiny').status, 'IN');
  assert.equal(store.getPlan('hkg-as3-tiny').last_known, 'IN');
  assert.equal(store.transitionsForPlan('hkg-as3-tiny').length, 1);
});

test('stale external control (older than 5 min) stops vouching — no false IN', async () => {
  const wl = loadWatchlist();
  const hkIds = new Set(wl.plans.filter((p) => p.family === 'hkg/as3').map((p) => p.id));
  let t = 1_000_000_000;
  const store = openStore(':memory:');
  store.seedFromWatchlist(wl);
  const watcher = createWatcher({
    store,
    watchlist: wl,
    now: () => t,
    pageSource: makeFixtureSource({
      'lax/as3': familyFixtures(wl, 'lax/as3'),
      'hkg/as3': familyFixtures(wl, 'hkg/as3', { inStock: hkIds }),
    }),
  });

  await watcher.pollFamily('lax/as3'); // control recorded at t
  t += 6 * 60_000; // …but 6 minutes pass before the HKG read
  const s = await watcher.pollFamily('hkg/as3');
  assert.deepEqual(s.fired, []);
  assert.ok(Object.values(s.statuses).every((st) => st === 'UNKNOWN'));
});

test('blind escalation: persistent blind flips escalate:true and persists for the panel', async () => {
  const wl = loadWatchlist();
  let t = 1_000_000_000;
  let page = readFixture('garbled.txt'); // markers missing → UNKNOWN streaks
  const store = openStore(':memory:');
  store.seedFromWatchlist(wl);
  const watcher = createWatcher({
    store,
    watchlist: wl,
    now: () => t,
    pageSource: makeFixtureSource({ 'hkg/as3': () => ({ ok: true, status: 200, pageText: page }) }),
  });
  const blinds = [];
  const cleared = [];
  watcher.on('blind', (b) => blinds.push(b));
  watcher.on('blind:cleared', (b) => cleared.push(b));

  await watcher.pollFamily('hkg/as3');
  t += 60_000;
  await watcher.pollFamily('hkg/as3');
  t += 60_000;
  await watcher.pollFamily('hkg/as3'); // 3rd bad cycle → blind entry
  assert.equal(blinds.length, 1);
  assert.equal(blinds[0].escalate, false, 'fresh blind must stay panel-only');
  const since = blinds[0].sinceMs;

  // Persisted for /api/health + the panel.
  let h = store.getFamilyHealth('hkg/as3');
  assert.equal(h.blind, 1);
  assert.match(h.blind_reasons, /persistent-unknown/);
  assert.equal(h.blind_since, since);

  // 4 hours later (past blindEscalateSec=3h AND the 1h re-notify throttle):
  t += 4 * 3_600_000;
  await watcher.pollFamily('hkg/as3');
  assert.equal(blinds.length, 2);
  assert.equal(blinds[1].escalate, true, 'persistent blind must escalate');
  assert.equal(blinds[1].sinceMs, since, 'escalation keeps the original onset');

  // Recovery: a trustworthy all-OUT render clears blind everywhere.
  page = familyFixtures(wl, 'hkg/as3');
  t += 60_000;
  await watcher.pollFamily('hkg/as3');
  assert.equal(cleared.length, 1);
  h = store.getFamilyHealth('hkg/as3');
  assert.equal(h.blind, 0);
  assert.equal(h.blind_reasons, null);
  assert.equal(h.blind_since, null);
});

test('restart hydration: a pre-restart blind onset survives and escalates immediately', async () => {
  const wl = loadWatchlist();
  const HOUR = 3_600_000;
  let t = 1_000_000_000;
  const store = openStore(':memory:');
  store.seedFromWatchlist(wl);
  // The previous process saw hkg/as3 go blind 4h ago (past blindEscalateSec=3h).
  const oldOnset = t - 4 * HOUR;
  store.setFamilyHealth('hkg/as3', { blind: true, blindReasons: 'persistent-unknown', blindSince: oldOnset });

  const watcher = createWatcher({
    store,
    watchlist: wl,
    now: () => t,
    pageSource: makeFixtureSource({ 'hkg/as3': () => ({ ok: true, status: 200, pageText: readFixture('garbled.txt') }) }),
  });
  const blinds = [];
  watcher.on('blind', (b) => blinds.push(b));

  // Re-confirmation grace: the persisted row must survive the first cycles.
  await watcher.pollFamily('hkg/as3');
  t += 60_000;
  await watcher.pollFamily('hkg/as3');
  let h = store.getFamilyHealth('hkg/as3');
  assert.equal(h.blind, 1, 'grace period must not wipe the persisted blind row');
  assert.equal(h.blind_since, oldOnset);
  assert.equal(blinds.length, 0);

  t += 60_000;
  await watcher.pollFamily('hkg/as3'); // 3rd bad cycle → re-confirmed
  assert.equal(blinds.length, 1);
  assert.equal(blinds[0].sinceMs, oldOnset, 'onset must carry across the restart');
  assert.equal(blinds[0].escalate, true, 'already past blindEscalateSec → escalate now, not in another 3h');
  h = store.getFamilyHealth('hkg/as3');
  assert.equal(h.blind_since, oldOnset);
});

test('restart hydration: a family that recovered while the process was down clears cleanly', async () => {
  const wl = loadWatchlist();
  let t = 1_000_000_000;
  const store = openStore(':memory:');
  store.seedFromWatchlist(wl);
  store.setFamilyHealth('hkg/as3', { blind: true, blindReasons: 'persistent-unknown', blindSince: t - 7_200_000 });

  const watcher = createWatcher({
    store,
    watchlist: wl,
    now: () => t,
    pageSource: makeFixtureSource({ 'hkg/as3': familyFixtures(wl, 'hkg/as3') }), // healthy all-OUT render
  });
  const blinds = [];
  const cleared = [];
  watcher.on('blind', (b) => blinds.push(b));
  watcher.on('blind:cleared', (b) => cleared.push(b));

  for (let i = 0; i < 3; i += 1) {
    await watcher.pollFamily('hkg/as3');
    t += 60_000;
  }
  assert.equal(blinds.length, 0);
  assert.equal(cleared.length, 1, 'recovery-during-downtime clears once re-confirmed');
  const h = store.getFamilyHealth('hkg/as3');
  assert.equal(h.blind, 0);
  assert.equal(h.blind_since, null);
});
