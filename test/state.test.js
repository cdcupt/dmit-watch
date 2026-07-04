// Unit tests for the PURE projection layer (src/state.js) against an in-memory
// store + the real watchlist. These mirror the /api/state, /api/health and
// /api/history data contracts (TECH §09–§10).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { loadWatchlist } from '../src/config.js';
import {
  buildState,
  buildHealth,
  buildHistory,
  planDeltaFor,
  latestHistoryRow,
  durationText,
} from '../src/state.js';

function freshStore() {
  const store = openStore(':memory:');
  store.seedFromWatchlist(loadWatchlist());
  store.touchHeartbeat({ chromeSession: 'UP' });
  return store;
}
const watchlist = () => loadWatchlist();

test('buildState: 37 plans, fixed datacenter/generation order, all-OUT counts', () => {
  const store = freshStore();
  const s = buildState({ watchlist: watchlist(), store });
  const flat = s.datacenters.flatMap((dc) => dc.generations.flatMap((g) => g.plans));
  assert.equal(flat.length, 37);
  assert.deepEqual(s.datacenters.map((dc) => dc.loc), ['lax', 'hkg', 'tyo', 'hnl']);
  assert.deepEqual(s.counts, {
    total: 37,
    in: 0,
    waiting: 37,
    byLoc: { lax: 16, hkg: 10, tyo: 7, hnl: 4 },
    byGen: { as3: 18, an4: 5, an5: 10, vds: 4 },
  });
  // every plan starts "out" with a usable https deep link (dmit cart.php or a
  // provider's own order page)
  assert.ok(flat.every((p) => p.status === 'out'));
  assert.ok(flat.every((p) => p.deepLink.startsWith('https://')));
  store.close();
});

test('buildState: a stored IN plan flips status + counts and carries inSinceMs', () => {
  const store = freshStore();
  const ts = Date.now();
  store.setPlanState('lax-an4-medium', { status: 'IN', lastKnown: 'IN', lastChecked: ts, lastChange: ts });
  const s = buildState({ watchlist: watchlist(), store, alarmed: new Set(['lax-an4-medium']) });
  assert.equal(s.counts.in, 1);
  assert.equal(s.counts.waiting, 36);
  const plan = s.datacenters
    .flatMap((dc) => dc.generations.flatMap((g) => g.plans))
    .find((p) => p.id === 'lax-an4-medium');
  assert.equal(plan.status, 'in');
  assert.equal(plan.inSinceMs, ts);
  assert.equal(plan.alarm, true); // in alarmed set AND status in
  store.close();
});

test('buildState: UNKNOWN never reads as in-stock', () => {
  const store = freshStore();
  store.setPlanState('hkg-as3-tiny', { status: 'UNKNOWN' });
  const s = buildState({ watchlist: watchlist(), store });
  const plan = s.datacenters
    .flatMap((dc) => dc.generations.flatMap((g) => g.plans))
    .find((p) => p.id === 'hkg-as3-tiny');
  assert.equal(plan.status, 'unknown');
  assert.equal(s.counts.in, 0);
  store.close();
});

test('planDeltaFor: alarm is only true when status is in AND id is alarmed', () => {
  const store = freshStore();
  store.setPlanState('tyo-as3-tiny', { status: 'IN', lastKnown: 'IN', lastChange: Date.now() });
  const armed = planDeltaFor('tyo-as3-tiny', { watchlist: watchlist(), store, alarmed: new Set(['tyo-as3-tiny']) });
  assert.equal(armed.alarm, true);
  const silenced = planDeltaFor('tyo-as3-tiny', { watchlist: watchlist(), store, alarmed: new Set() });
  assert.equal(silenced.alarm, false);
  assert.equal(silenced.status, 'in'); // still in stock, just not ringing
  assert.equal(planDeltaFor('does-not-exist', { watchlist: watchlist(), store }), null);
  store.close();
});

test('buildHistory + latestHistoryRow: durations + ordering', () => {
  const store = freshStore();
  const t1 = Date.now() - 60000;
  const t2 = Date.now();
  store.recordTransition({ planId: 'lax-an4-medium', from: 'OUT', to: 'IN', ts: t1 });
  store.recordTransition({ planId: 'lax-an4-medium', from: 'IN', to: 'OUT', ts: t2, durationInStock: 75 });
  const h = buildHistory({ watchlist: watchlist(), store, limit: 10 });
  assert.equal(h.transitions[0].to, 'out'); // newest first
  assert.equal(h.transitions[0].dur, 'in stock for 1m 15s');
  assert.equal(h.transitions[1].to, 'in');
  assert.equal(h.transitions[1].dur, 'alert fired');
  const latest = latestHistoryRow('lax-an4-medium', { watchlist: watchlist(), store });
  assert.equal(latest.to, 'out');
  assert.equal(latest.name, 'LAX.AN4.Pro.MEDIUM');
  store.close();
});

test('buildHealth: 7 families + telegram rows mapped to plan names', () => {
  const store = freshStore();
  store.logTelegram({ planId: 'lax-an4-medium', message: 'x', sentOk: true });
  store.logTelegram({ planId: null, message: 'blind', sentOk: false, lastError: 'http 500' });
  const h = buildHealth({ watchlist: watchlist(), store });
  assert.equal(h.families.length, 7);
  const names = h.telegram.map((t) => t.name);
  assert.ok(names.includes('LAX.AN4.Pro.MEDIUM'));
  assert.ok(names.includes('Watcher blind alert'));
  store.close();
});

test('buildState: outSinceMs mirrors inSinceMs — set on OUT after a transition (ST-U1)', () => {
  const store = freshStore();
  const tIn = Date.now() - 60_000;
  const tOut = Date.now();
  // IN → OUT: last_change now marks when the plan sold out.
  store.setPlanState('lax-an4-medium', { status: 'IN', lastKnown: 'IN', lastChecked: tIn, lastChange: tIn });
  store.setPlanState('lax-an4-medium', { status: 'OUT', lastKnown: 'OUT', lastChecked: tOut, lastChange: tOut });
  const s = buildState({ watchlist: watchlist(), store });
  const plan = s.datacenters
    .flatMap((dc) => dc.generations.flatMap((g) => g.plans))
    .find((p) => p.id === 'lax-an4-medium');
  assert.equal(plan.status, 'out');
  assert.equal(plan.outSinceMs, tOut);
  assert.equal(plan.inSinceMs, null);
  store.close();
});

test('buildState: seeded-OUT plans that never transitioned have outSinceMs null (ST-U2)', () => {
  const store = freshStore();
  const s = buildState({ watchlist: watchlist(), store });
  const flat = s.datacenters.flatMap((dc) => dc.generations.flatMap((g) => g.plans));
  // Render-if-present contract: the board shows no since-line for these.
  assert.ok(flat.every((p) => p.outSinceMs === null));
  store.close();
});

test('buildState: IN plan symmetry — inSinceMs set, outSinceMs null (ST-U3)', () => {
  const store = freshStore();
  const ts = Date.now();
  store.setPlanState('tyo-as3-tiny', { status: 'IN', lastKnown: 'IN', lastChecked: ts, lastChange: ts });
  const s = buildState({ watchlist: watchlist(), store });
  const plan = s.datacenters
    .flatMap((dc) => dc.generations.flatMap((g) => g.plans))
    .find((p) => p.id === 'tyo-as3-tiny');
  assert.equal(plan.inSinceMs, ts);
  assert.equal(plan.outSinceMs, null);
  store.close();
});

test('buildState: family provider surfaces on each generation, defaulting to dmit (ST-U4)', () => {
  const store = freshStore();
  const s = buildState({ watchlist: watchlist(), store });
  const gens = s.datacenters.flatMap((dc) => dc.generations);
  const vds = gens.find((g) => g.key === 'hnl/vds');
  assert.equal(vds.provider, 'whmcs'); // qq.pw Hawaii VDS — data-driven DC badge
  const dmit = gens.find((g) => g.key === 'lax/an4');
  assert.equal(dmit.provider, 'dmit'); // families without the field resolve to the default
  assert.ok(gens.every((g) => typeof g.provider === 'string' && g.provider.length > 0));
  store.close();
});

test('durationText edge cases', () => {
  assert.equal(durationText(null), null);
  assert.equal(durationText(0), 'in stock for 0s');
  assert.equal(durationText(59), 'in stock for 59s');
  assert.equal(durationText(125), 'in stock for 2m 5s');
});

test('buildHealth projects the blind flag, reasons, and onset for the panel', () => {
  const store = freshStore();
  store.setFamilyHealth('hkg/as3', {
    blind: true,
    blindReasons: 'persistent-unknown,structure-markers-missing',
    blindSince: 777,
  });
  const h = buildHealth({ watchlist: watchlist(), store });

  const hk = h.families.find((f) => f.key === 'hkg/as3');
  assert.equal(hk.blind, true);
  assert.deepEqual(hk.blindReasons, ['persistent-unknown', 'structure-markers-missing']);
  assert.equal(hk.blindSinceMs, 777);

  const lax = h.families.find((f) => f.key === 'lax/as3');
  assert.equal(lax.blind, false);
  assert.deepEqual(lax.blindReasons, []);
  assert.equal(lax.blindSinceMs, null);
  store.close();
});
