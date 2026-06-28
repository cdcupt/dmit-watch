// Unit tests for the deep-link builder (src/chrome.js familyUrl) and the
// region/generation validation gate (src/config.js). TECH §16: LAX→los-angeles,
// HKG→hong-kong, TYO→tokyo, generation lower-cased, bad region/gen → throws.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familyUrl } from '../src/chrome.js';
import { loadWatchlist, removeFamilyFromWatchlist } from '../src/config.js';

const SETTINGS = { baseUrl: 'https://www.dmit.io', cartPath: '/cart.php', network: 'premium', language: 'english' };

const fam = (regionSlug, gen) => ({ regionSlug, gen });

test('builds the cart.php deep link from regionSlug + generation', () => {
  const url = familyUrl(SETTINGS, fam('los-angeles', 'an5'));
  assert.equal(
    url,
    'https://www.dmit.io/cart.php?region=los-angeles&network=premium&generation=an5&language=english',
  );
});

test('region mapping: LAX→los-angeles, HKG→hong-kong, TYO→tokyo (from the real watchlist)', () => {
  const wl = loadWatchlist();
  const cases = [
    ['lax/as3', 'region=los-angeles'],
    ['hkg/an5', 'region=hong-kong'],
    ['tyo/as3', 'region=tokyo'],
  ];
  for (const [key, frag] of cases) {
    const family = wl.families.find((f) => f.key === key);
    const url = familyUrl(wl.settings, { ...family, deepLink: undefined });
    assert.ok(url.includes(frag), `${key} → ${url}`);
    assert.ok(url.includes(`generation=${family.gen}`), `${key} generation lower-cased`);
  }
});

test('generation is carried through lower-cased, never the uppercase label', () => {
  const url = familyUrl(SETTINGS, fam('tokyo', 'as3'));
  assert.ok(url.includes('generation=as3'));
  assert.ok(!url.includes('AS3'));
});

test('falls back to loc when regionSlug is absent, and honours a precomputed deepLink', () => {
  assert.ok(familyUrl(SETTINGS, { loc: 'lax', gen: 'an4' }).includes('region=lax'));
  const explicit = 'https://example.test/cart.php?prebuilt=1';
  assert.equal(familyUrl(SETTINGS, { deepLink: explicit, regionSlug: 'x', gen: 'y' }), explicit);
});

test('settings overrides (baseUrl/cartPath/network/language) flow into the link', () => {
  const url = familyUrl(
    { baseUrl: 'https://mirror.test/', cartPath: '/buy.php', network: 'eyeball', language: 'zh' },
    fam('tokyo', 'an5'),
  );
  assert.equal(url, 'https://mirror.test/buy.php?region=tokyo&network=eyeball&generation=an5&language=zh');
});

// ---- the "bad region/gen → throws" guard lives in the config validator ------

test('loadWatchlist rejects a plan with an unknown generation', () => {
  const wl = loadWatchlist();
  const bad = { ...wl, plans: wl.plans.map((p, i) => (i === 0 ? { ...p, gen: 'zz9' } : p)) };
  // round-trip through a temp file via the same validator the loader uses
  assert.throws(() => validateInline(bad), /unknown gen "zz9"/);
});

test('loadWatchlist rejects a plan with an unknown region/loc', () => {
  const wl = loadWatchlist();
  const bad = { ...wl, plans: wl.plans.map((p, i) => (i === 0 ? { ...p, loc: 'mars' } : p)) };
  assert.throws(() => validateInline(bad), /unknown loc "mars"/);
});

test('removeFamilyFromWatchlist refuses to empty the watchlist and is immutable', () => {
  const wl = loadWatchlist();
  const before = wl.families.length;
  const next = removeFamilyFromWatchlist(wl, 'tyo/as3');
  assert.equal(wl.families.length, before); // input untouched
  assert.ok(!next.families.some((f) => f.key === 'tyo/as3'));
  assert.throws(() => removeFamilyFromWatchlist(wl, 'nope/xx'), /not in the watchlist/);
});

// loadWatchlist only reads from disk; to assert the validator's loc/gen guards on
// an in-memory object we round-trip it through a temp file.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
function validateInline(obj) {
  const f = join(tmpdir(), `dmit-deeplink-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(obj));
  try {
    return loadWatchlist(f);
  } finally {
    rmSync(f, { force: true });
  }
}
