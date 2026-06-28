// Unit tests for the PURE detector (src/detect.js): classification, sanity
// gates, edge engine, and the blind-watcher net. Runs against text fixtures.
//   node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STOCK,
  pageMarkers,
  cardSegment,
  classifyFamily,
  computePlanEdge,
  computeEdges,
  assessBlindness,
} from '../src/detect.js';
import { loadWatchlist } from '../src/config.js';
import { readFixture } from './helpers.js';

const wl = loadWatchlist();
const FAM = 'lax/an5';
const family = wl.families.find((f) => f.key === FAM);
const plans = wl.plans.filter((p) => p.family === FAM);
const K = wl.settings.controlGroupMinK;

const statusOf = (det, id) => det.results.find((r) => r.id === id).stock;

test('all-out fixture -> every plan OUT, markers present', () => {
  const det = classifyFamily({ pageText: readFixture('all-out.txt'), family, plans, controlGroupMinK: K });
  assert.equal(det.markersPresent, true);
  assert.equal(det.countMatch, true);
  for (const r of det.results) assert.equal(r.stock, STOCK.OUT, `${r.name} should be OUT`);
});

test('synthetic orderable fixture -> MINI IN, others OUT (gates pass)', () => {
  const det = classifyFamily({ pageText: readFixture('orderable.synthetic.txt'), family, plans, controlGroupMinK: K });
  assert.equal(statusOf(det, 'lax-an5-mini'), STOCK.IN);
  assert.equal(statusOf(det, 'lax-an5-micro'), STOCK.OUT);
  assert.equal(statusOf(det, 'lax-an5-giant'), STOCK.OUT);
  assert.equal(det.controlOutCount, 4); // 4 others still OUT
});

test('control-group gate: too few OUT plans -> candidate falls back to UNKNOWN, never IN', () => {
  // K raised above what the page can support: only 4 OUT, require 5.
  const det = classifyFamily({ pageText: readFixture('orderable.synthetic.txt'), family, plans, controlGroupMinK: 5 });
  const mini = det.results.find((r) => r.id === 'lax-an5-mini');
  assert.equal(mini.stock, STOCK.UNKNOWN);
  assert.match(mini.reason, /control/);
});

test('CF challenge -> blocked, markers absent, all UNKNOWN (never IN)', () => {
  const det = classifyFamily({ pageText: readFixture('cf-challenge.txt'), family, plans, controlGroupMinK: K });
  assert.equal(det.markersPresent, false);
  assert.equal(det.blocked, true);
  for (const r of det.results) assert.equal(r.stock, STOCK.UNKNOWN);
});

test('truncated page (some cards missing) -> countMatch false, present cards UNKNOWN not IN', () => {
  const full = readFixture('orderable.synthetic.txt');
  // drop everything from MEDIUM onward -> only MINI + MICRO remain
  const truncated = full.slice(0, full.indexOf('LAX.AN5.Pro.MEDIUM')) + '\nTOTAL DUE TODAY: $79.90\n';
  const det = classifyFamily({ pageText: truncated, family, plans, controlGroupMinK: K });
  assert.equal(det.countMatch, false);
  // MINI is orderable but the page is truncated -> must NOT be IN
  assert.equal(statusOf(det, 'lax-an5-mini'), STOCK.UNKNOWN);
});

test('pageMarkers flags a login wall', () => {
  const m = pageMarkers({ pageText: 'Login to your account\nPassword', family, plans });
  assert.equal(m.loginWall, true);
  assert.equal(m.markersPresent, false);
});

test('cardSegment isolates a card and stops at the next name / footer', () => {
  const seg = cardSegment(readFixture('all-out.txt'), 'LAX.AN5.Pro.MINI', plans.map((p) => p.name));
  assert.match(seg, /LAX\.AN5\.Pro\.MINI/);
  assert.match(seg, /Out of Stock/);
  assert.doesNotMatch(seg, /MICRO/); // bounded before the next card
});

// ---- edge engine ----------------------------------------------------------

test('computePlanEdge fires once on armed OUT->IN, then disarms', () => {
  const e = computePlanEdge({ stock: STOCK.IN, stored: { last_known: 'OUT', armed: 1 } });
  assert.equal(e.fire, true);
  assert.equal(e.newArmed, false);
  assert.deepEqual(e.transition, { from: 'OUT', to: 'IN', duration: null });
});

test('computePlanEdge does NOT re-fire when already IN / disarmed', () => {
  const e = computePlanEdge({ stock: STOCK.IN, stored: { last_known: 'IN', armed: 0 } });
  assert.equal(e.fire, false);
  assert.equal(e.transition, null);
});

test('computePlanEdge re-arms on IN->OUT and records duration', () => {
  const now = 100_000;
  const e = computePlanEdge({ stock: STOCK.OUT, stored: { last_known: 'IN', armed: 0, last_change: now - 41_000 }, now });
  assert.equal(e.rearm, true);
  assert.equal(e.newArmed, true);
  assert.equal(e.transition.from, 'IN');
  assert.equal(e.transition.duration, 41);
});

test('UNKNOWN holds position: no edge, no re-arm, last_known untouched', () => {
  const e = computePlanEdge({ stock: STOCK.UNKNOWN, stored: { last_known: 'OUT', armed: 1 } });
  assert.equal(e.fire, false);
  assert.equal(e.rearm, false);
  assert.equal(e.newLastKnown, 'OUT');
  assert.equal(e.transition, null);
});

test('UNKNOWN after a fire never re-arms (a read blip cannot re-trigger)', () => {
  // disarmed (just fired); a blip reads UNKNOWN; must stay disarmed
  const e = computePlanEdge({ stock: STOCK.UNKNOWN, stored: { last_known: 'IN', armed: 0 } });
  assert.equal(e.newArmed, false);
  assert.equal(e.rearm, false);
});

test('cooldown suppresses the alert but still records the transition', () => {
  const now = 1_000_000;
  const e = computePlanEdge({
    stock: STOCK.IN,
    stored: { last_known: 'OUT', armed: 1, last_change: now - 5_000 },
    now,
    cooldownMs: 600_000,
  });
  assert.equal(e.fire, false); // within cooldown
  assert.ok(e.transition); // but the OUT->IN is still real
  assert.equal(e.newArmed, false);
});

test('computeEdges buckets fired vs rearmed across a family', () => {
  const results = [
    { id: 'a', name: 'A', stock: STOCK.IN },
    { id: 'b', name: 'B', stock: STOCK.OUT },
    { id: 'c', name: 'C', stock: STOCK.UNKNOWN },
  ];
  const stored = {
    a: { last_known: 'OUT', armed: 1 },
    b: { last_known: 'IN', armed: 0, last_change: 0 },
    c: { last_known: 'OUT', armed: 1 },
  };
  const { fired, rearmed } = computeEdges(results, stored, { now: 10_000 });
  assert.deepEqual(fired.map((e) => e.id), ['a']);
  assert.deepEqual(rearmed.map((e) => e.id), ['b']);
});

// ---- blind-watcher net ----------------------------------------------------

test('assessBlindness: persistent per-plan UNKNOWN trips at N', () => {
  const a = assessBlindness({ blindCycles: 3, unknownStreaks: { x: 3, y: 1 } });
  assert.equal(a.blind, true);
  assert.deepEqual(a.plans, ['x']);
  assert.ok(a.reasons.includes('persistent-unknown'));
});

test('assessBlindness: missing markers and persistent block trip distinctly', () => {
  const a = assessBlindness({ blindCycles: 3, markerMissingStreak: 3 });
  assert.ok(a.reasons.includes('structure-markers-missing'));
  const b = assessBlindness({ blindCycles: 3, blockedStreak: 4 });
  assert.ok(b.reasons.includes('persistent-block'));
});

test('assessBlindness: below threshold = not blind', () => {
  const a = assessBlindness({ blindCycles: 3, unknownStreaks: { x: 2 }, markerMissingStreak: 1, blockedStreak: 2 });
  assert.equal(a.blind, false);
  assert.deepEqual(a.reasons, []);
});

// ---- garbled / fuzz: the "never IN" invariant -----------------------------

test('garbled binary fixture -> markers absent, all UNKNOWN, never IN', () => {
  const det = classifyFamily({ pageText: readFixture('garbled.txt'), family, plans, controlGroupMinK: K });
  assert.equal(det.markersPresent, false);
  for (const r of det.results) assert.equal(r.stock, STOCK.UNKNOWN);
  assert.equal(det.results.filter((r) => r.stock === STOCK.IN).length, 0);
});

// Tiny deterministic LCG so the fuzz corpus is reproducible across runs.
function lcg(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}

test('FUZZ: random binary DOMs never resolve any plan to IN (5000 cases)', () => {
  const rnd = lcg(424242);
  for (let i = 0; i < 5000; i++) {
    const len = 1 + Math.floor(rnd() * 400);
    let s = '';
    for (let j = 0; j < len; j++) s += String.fromCharCode(Math.floor(rnd() * 256));
    const det = classifyFamily({ pageText: s, family, plans, controlGroupMinK: K });
    assert.equal(det.results.some((r) => r.stock === STOCK.IN), false, `case ${i} leaked an IN`);
  }
});

test('FUZZ: structurally-anchored pages with NO price/orderable signal never go IN (1000 cases)', () => {
  // Markers can be present (anchors + generation + plan names + "premium"), but
  // with no "$" price and no out-of-stock label every card is a price-gate-fail
  // candidate -> UNKNOWN. Proves: structure alone is not a positive orderable signal.
  const rnd = lcg(7);
  const NOISE = ['lorem', 'ipsum', '◆◆◆', '???', 'configure your', 'instance scale', 'premium'];
  for (let i = 0; i < 1000; i++) {
    let page = 'Configure Your Cloud Server\nInstance Scale\nPremium\nAS3 AN4 AN5\n';
    for (const p of plans) {
      page += `${p.name}\n`;
      // sprinkle random non-price, non-OOS noise
      const n = Math.floor(rnd() * 4);
      for (let k = 0; k < n; k++) page += `${NOISE[Math.floor(rnd() * NOISE.length)]} `;
      page += '\n';
    }
    page += 'TOTAL DUE TODAY: Unavailable\n';
    const det = classifyFamily({ pageText: page, family, plans, controlGroupMinK: K });
    assert.equal(det.results.some((r) => r.stock === STOCK.IN), false, `case ${i} leaked an IN`);
  }
});
