// Unit tests for poll-cadence resolution (src/config.js resolveCadenceSec).
//
// The friendly knob is a single number of seconds (settings.cadenceSec, default
// 60) turned into a ±10% jitter band; a legacy [min,max] array still works; the
// env var DMIT_WATCH_CADENCE_SEC wins over the file; a bad value never crashes —
// it warns and falls back to the default; and a too-low value is clamped to the
// 20s politeness floor.  node --test test/cadence.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCadenceSec, loadWatchlist } from '../src/config.js';
import { nextDelayMs } from '../src/backoff.js';

/** A logger that records warnings so tests can assert on (or assert the absence of) them. */
function capture() {
  const warnings = [];
  return { logger: { warn: (m) => warnings.push(String(m)) }, warnings };
}

test('single number 60 → ~60s band (±10%): [54, 66]', () => {
  const { logger, warnings } = capture();
  const band = resolveCadenceSec({ cadenceSec: 60 }, { env: {}, logger });
  assert.deepEqual(band, [54, 66]);
  assert.equal(warnings.length, 0, 'a valid 60 must not warn');
});

test('the resolved band feeds backoff jitter and stays within [54s, 66s]', () => {
  const band = resolveCadenceSec({ cadenceSec: 60 }, { env: {} });
  for (let i = 0; i <= 100; i++) {
    const r = i / 100;
    const ms = nextDelayMs({ cadenceSec: band, level: 0, rng: () => r });
    assert.ok(ms >= 54_000 && ms <= 66_000, `r=${r} → ${ms}ms out of window`);
  }
});

test('legacy [min,max] array is still honored (backward compat)', () => {
  const { logger, warnings } = capture();
  assert.deepEqual(resolveCadenceSec({ cadenceSec: [60, 90] }, { env: {}, logger }), [60, 90]);
  assert.equal(warnings.length, 0, 'a valid legacy band must not warn');
});

test('env DMIT_WATCH_CADENCE_SEC (positive number) wins over a single-number file value', () => {
  const band = resolveCadenceSec({ cadenceSec: 60 }, { env: { DMIT_WATCH_CADENCE_SEC: '30' } });
  assert.deepEqual(band, [27, 33]); // 30 ±10%
});

test('env override wins over a legacy [min,max] file value too', () => {
  const band = resolveCadenceSec({ cadenceSec: [60, 90] }, { env: { DMIT_WATCH_CADENCE_SEC: '50' } });
  assert.deepEqual(band, [45, 55]); // 50 ±10%
});

test('an invalid env value is ignored; the file value is used + a warning is logged', () => {
  const { logger, warnings } = capture();
  const band = resolveCadenceSec({ cadenceSec: 60 }, { env: { DMIT_WATCH_CADENCE_SEC: 'soon' }, logger });
  assert.deepEqual(band, [54, 66]);
  assert.match(warnings.join('\n'), /DMIT_WATCH_CADENCE_SEC.*not a positive number/);
});

test('an invalid file value falls back to the 60s default + a warning (never crashes)', () => {
  for (const bad of [0, -5, 'fast', {}, null, NaN, Infinity]) {
    const { logger, warnings } = capture();
    const band = resolveCadenceSec({ cadenceSec: bad }, { env: {}, logger });
    assert.deepEqual(band, [54, 66], `bad=${JSON.stringify(bad)} should yield the default band`);
    assert.ok(warnings.length >= 1, `bad=${JSON.stringify(bad)} should warn`);
  }
});

test('a missing cadenceSec uses the default silently (no warning)', () => {
  const { logger, warnings } = capture();
  assert.deepEqual(resolveCadenceSec({}, { env: {}, logger }), [54, 66]);
  assert.equal(warnings.length, 0);
});

test('a too-low single number is clamped to the 20s floor + warns', () => {
  const { logger, warnings } = capture();
  const band = resolveCadenceSec({ cadenceSec: 5 }, { env: {}, logger });
  assert.deepEqual(band, [18, 22]); // 20 ±10%
  assert.match(warnings.join('\n'), /below the 20s floor/);
});

test('a too-low env value is clamped to the floor too', () => {
  const { logger, warnings } = capture();
  const band = resolveCadenceSec({ cadenceSec: 60 }, { env: { DMIT_WATCH_CADENCE_SEC: '3' }, logger });
  assert.deepEqual(band, [18, 22]);
  assert.match(warnings.join('\n'), /below the 20s floor/);
});

test('a malformed legacy array falls back to the default + warns', () => {
  const { logger, warnings } = capture();
  assert.deepEqual(resolveCadenceSec({ cadenceSec: [90, 60] }, { env: {}, logger }), [54, 66]); // min>max
  assert.deepEqual(resolveCadenceSec({ cadenceSec: [0, 90] }, { env: {}, logger }), [54, 66]); // non-positive
  assert.deepEqual(resolveCadenceSec({ cadenceSec: [60] }, { env: {}, logger }), [54, 66]); // wrong length
  assert.ok(warnings.length >= 3);
});

test('a valid legacy band below the floor is clamped, not rejected', () => {
  const { logger, warnings } = capture();
  assert.deepEqual(resolveCadenceSec({ cadenceSec: [5, 8] }, { env: {}, logger }), [20, 20]);
  assert.match(warnings.join('\n'), /below the 20s floor/);
});

// CAD-U6 (subscriptions TECH §B6): the shipped knob is now 300 s. resolveCadenceSec
// emits the [270, 330] jitter band (±10%) automatically; the floor and the env
// override are re-asserted at the new base below.
test('the real config/watchlist.json resolves to the ~300s band (5-minute cadence)', () => {
  const wl = loadWatchlist();
  assert.equal(wl.settings.cadenceSec, 300, 'shipped config should use the single-number form');
  assert.deepEqual(resolveCadenceSec(wl.settings, { env: {} }), [270, 330]);
});

test('single number 300 → ±10% band [270, 330]; floor + env override still hold at the new base', () => {
  const { logger, warnings } = capture();
  assert.deepEqual(resolveCadenceSec({ cadenceSec: 300 }, { env: {}, logger }), [270, 330]);
  assert.equal(warnings.length, 0, 'a valid 300 must not warn');
  // The env knob still wins over the file's 300 (the quick way back to a faster beat)…
  assert.deepEqual(
    resolveCadenceSec({ cadenceSec: 300 }, { env: { DMIT_WATCH_CADENCE_SEC: '60' } }),
    [54, 66],
  );
  // …and the 20s politeness floor still clamps a too-low override.
  const low = capture();
  assert.deepEqual(
    resolveCadenceSec({ cadenceSec: 300 }, { env: { DMIT_WATCH_CADENCE_SEC: '3' }, logger: low.logger }),
    [18, 22],
  );
  assert.match(low.warnings.join('\n'), /below the 20s floor/);
});

test('resolveCadenceSec never throws on hostile input', () => {
  assert.doesNotThrow(() => resolveCadenceSec(undefined, { env: {} }));
  assert.doesNotThrow(() => resolveCadenceSec({ cadenceSec: Infinity }, { env: {} }));
  assert.doesNotThrow(() => resolveCadenceSec({ cadenceSec: NaN }, { env: {} }));
});
