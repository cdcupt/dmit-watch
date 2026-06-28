// Unit tests for the pure jitter/backoff math (src/backoff.js). TECH §16:
// normal ∈ [60s, 90s]; delay = min(base·2ⁿ, cap); monotonic in level; clamps at
// the cap; deterministic under a seeded RNG.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDelayMs } from '../src/backoff.js';

const CAD = [60, 90];

test('level 0 jitter stays within the [60s, 90s] cadence window', () => {
  // sweep the RNG across its full [0,1) range
  for (let i = 0; i <= 100; i++) {
    const r = i / 100;
    const ms = nextDelayMs({ cadenceSec: CAD, level: 0, rng: () => r });
    assert.ok(ms >= 60_000 && ms <= 90_000, `r=${r} → ${ms}ms out of window`);
  }
});

test('rng=0 → cadence floor (60s); rng→1 → cadence ceiling (≈90s)', () => {
  assert.equal(nextDelayMs({ cadenceSec: CAD, level: 0, rng: () => 0 }), 60_000);
  const hi = nextDelayMs({ cadenceSec: CAD, level: 0, rng: () => 0.999999 });
  assert.ok(hi > 89_999 && hi <= 90_000, `ceiling ${hi}`);
});

test('backoff doubles with level: delay = base · 2ⁿ (fixed base)', () => {
  const base = () => 0; // base = 60s exactly
  assert.equal(nextDelayMs({ cadenceSec: CAD, backoffFactor: 2, level: 0, rng: base }), 60_000);
  assert.equal(nextDelayMs({ cadenceSec: CAD, backoffFactor: 2, level: 1, rng: base }), 120_000);
  assert.equal(nextDelayMs({ cadenceSec: CAD, backoffFactor: 2, level: 2, rng: base }), 240_000);
  assert.equal(nextDelayMs({ cadenceSec: CAD, backoffFactor: 2, level: 3, rng: base }), 480_000);
});

test('delay is monotonic non-decreasing in level (same RNG draw)', () => {
  const rng = () => 0.5;
  let prev = -1;
  for (let level = 0; level <= 10; level++) {
    const ms = nextDelayMs({ cadenceSec: CAD, backoffFactor: 2, backoffCapSec: 900, level, rng });
    assert.ok(ms >= prev, `level ${level} (${ms}) < prev (${prev})`);
    prev = ms;
  }
});

test('clamps at the backoff cap and never exceeds it', () => {
  const cap = nextDelayMs({ cadenceSec: CAD, backoffFactor: 2, backoffCapSec: 900, level: 20, rng: () => 0.999 });
  assert.equal(cap, 900_000); // 900s ceiling, not 90s·2²⁰
  // a clean read (level 0) drops straight back under the window
  assert.ok(nextDelayMs({ cadenceSec: CAD, level: 0, rng: () => 0.5 }) <= 90_000);
});

test('seeded RNG is deterministic: identical inputs → identical delay', () => {
  const a = nextDelayMs({ cadenceSec: CAD, level: 2, rng: () => 0.37 });
  const b = nextDelayMs({ cadenceSec: CAD, level: 2, rng: () => 0.37 });
  assert.equal(a, b);
});

test('defaults are sane when called with no args (uses [60,90], factor 2, cap 900)', () => {
  const ms = nextDelayMs({ rng: () => 0 });
  assert.equal(ms, 60_000);
});
