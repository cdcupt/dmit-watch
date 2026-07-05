// Unit tests for the config boundary (src/config.js) — TECH unit/watchlist-config
// + AC6 "malformed config is rejected with a clear error". Every malformed shape
// must fail fast with an actionable message; a valid file round-trips on disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import { loadWatchlist, writeWatchlist, loadSecrets } from '../src/config.js';

const VALID = () => ({
  settings: { cadenceSec: [60, 90] },
  families: [{ key: 'lax/as3', loc: 'lax', gen: 'as3', label: 'LAX·AS3' }],
  plans: [
    {
      id: 'lax-as3-tiny', family: 'lax/as3', loc: 'lax', gen: 'as3',
      size: 'TINY', name: 'LAX.AS3.Pro.TINY', price: '$10.90',
      deepLink: 'https://www.dmit.io/cart.php?region=los-angeles&network=premium&generation=as3&language=english',
    },
  ],
});

function withFile(content) {
  const f = join(tmpdir(), `dmit-cfg-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
  return f;
}
function loadObj(obj) {
  const f = withFile(obj);
  try {
    return loadWatchlist(f);
  } finally {
    rmSync(f, { force: true });
  }
}
function expectReject(obj, re) {
  const f = withFile(obj);
  try {
    assert.throws(() => loadWatchlist(f), re);
  } finally {
    rmSync(f, { force: true });
  }
}

test('a missing file throws "not found"', () => {
  assert.throws(() => loadWatchlist(join(tmpdir(), 'nope-does-not-exist.json')), /not found/);
});

test('invalid JSON throws a clear parse error', () => {
  const f = withFile('{ not json ');
  try {
    assert.throws(() => loadWatchlist(f), /not valid JSON/);
  } finally {
    rmSync(f, { force: true });
  }
});

test('missing settings is rejected', () => {
  const v = VALID(); delete v.settings;
  expectReject(v, /settings missing/);
});

test('empty or non-array families is rejected', () => {
  expectReject({ ...VALID(), families: [] }, /families must be a non-empty array/);
  expectReject({ ...VALID(), families: 'lax' }, /families must be a non-empty array/);
});

test('empty or non-array plans is rejected', () => {
  expectReject({ ...VALID(), plans: [] }, /plans must be a non-empty array/);
});

test('a plan missing a required field is rejected by name', () => {
  const v = VALID(); delete v.plans[0].price;
  expectReject(v, /missing required field "price"/);
});

test('a duplicate plan id is rejected', () => {
  const v = VALID();
  v.plans = [v.plans[0], { ...v.plans[0] }];
  expectReject(v, /duplicate plan id/);
});

test('an unknown loc and an unknown gen are each rejected', () => {
  const badLoc = VALID(); badLoc.plans[0].loc = 'mars';
  expectReject(badLoc, /unknown loc "mars"/);
  const badGen = VALID(); badGen.plans[0].gen = 'zz9';
  expectReject(badGen, /unknown gen "zz9"/);
});

test('a plan referencing an unknown family is rejected', () => {
  const v = VALID(); v.plans[0].family = 'ghost/zz';
  expectReject(v, /unknown family "ghost\/zz"/);
});

test('a valid watchlist loads and round-trips through writeWatchlist', () => {
  const loaded = loadObj(VALID());
  assert.equal(loaded.plans.length, 1);

  const f = join(tmpdir(), `dmit-cfg-rt-${process.pid}.json`);
  try {
    writeWatchlist(loaded, f);
    const again = loadWatchlist(f);
    assert.deepEqual(again.plans, loaded.plans);
  } finally {
    rmSync(f, { force: true });
  }
});

test('the real config/watchlist.json is valid (37 plans, 7 families — hkg/an5 re-added)', () => {
  const wl = loadWatchlist();
  assert.equal(wl.plans.length, 37);
  assert.equal(wl.families.length, 7);
  // hkg/an5 is watchable again: DMIT re-enabled the generation 2026-07-04.
  // Its ?generation=an5 deep link still opens on AS3 (cart deep-link bug), but
  // the reader's generation-toggle fallback (src/chrome.js) clicks through, so
  // watching it is no longer permanent blind noise.
  assert.ok(wl.families.find((f) => f.key === 'hkg/an5'));
});

test('cadence knobs: 5-minute cadence + a backoff cap that restores a real ladder (§B6)', () => {
  const wl = loadWatchlist();
  // Round 2 (subscriptions TECH §B6): one check per plan every 5 minutes.
  assert.equal(wl.settings.cadenceSec, 300);
  // At base 300 with factor 2 the old 900 cap saturated after two doublings
  // (300→600→900-capped). 3600 restores a real ladder: 600 → 1200 → 2400 → 3600.
  assert.equal(wl.settings.backoffCapSec, 3600);
});

test('cooldown is short enough not to swallow a genuine brief restock', () => {
  // SHOULD-FIX: 600s suppressed alerts on real restocks within 10 min of a prior
  // sellout. 90s only dedupes a single flap. Re-notify defaults to hourly.
  // Since the 300s cadence (§B6) the cooldown is INERT — consecutive observations
  // of one family are ≥270s apart > 90s — but kept: harmless, and still meaningful
  // if cadence is ever lowered via DMIT_WATCH_CADENCE_SEC.
  const wl = loadWatchlist();
  assert.equal(wl.settings.cooldownSec, 90);
  assert.equal(wl.settings.blindRenotifySec, 3600);
  // Blind past this long escalates to Telegram (2026-07-03 missed-restock fix).
  assert.equal(wl.settings.blindEscalateSec, 10800);
});

test('loadSecrets: required:false returns null when creds are absent (Telegram optional)', () => {
  const noFile = join(tmpdir(), 'dmit-secrets-does-not-exist');
  // Neither cred anywhere → null, never a boot throw.
  assert.equal(loadSecrets({ required: false, env: {}, file: noFile }), null);
  // Half a cred pair is unusable by the notifier → also null under required:false…
  assert.equal(loadSecrets({ required: false, env: { TELEGRAM_BOT_TOKEN: 'X' }, file: noFile }), null);
  // …while the default required mode still fails fast, naming the missing key.
  assert.throws(() => loadSecrets({ env: {}, file: noFile }), /TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID/);
  assert.throws(
    () => loadSecrets({ env: { TELEGRAM_BOT_TOKEN: 'X' }, file: noFile }),
    /missing secret\(s\) TELEGRAM_CHAT_ID/,
  );
});

test('loadSecrets reads the env override and enforces required creds', () => {
  const prevToken = process.env.TELEGRAM_BOT_TOKEN;
  const prevChat = process.env.TELEGRAM_CHAT_ID;
  try {
    process.env.TELEGRAM_BOT_TOKEN = 'ENVBOT';
    process.env.TELEGRAM_CHAT_ID = 'ENVCHAT';
    const s = loadSecrets();
    assert.equal(s.botToken, 'ENVBOT');
    assert.equal(s.chatId, 'ENVCHAT');
    // required:false never throws and still returns whatever is present
    assert.equal(loadSecrets({ required: false }).botToken, 'ENVBOT');
  } finally {
    if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prevToken;
    if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = prevChat;
  }
});
