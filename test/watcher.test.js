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
