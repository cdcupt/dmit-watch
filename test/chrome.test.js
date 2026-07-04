// HIGH 4 regression: the CDP connect Origin (src/chrome.js / src/watcher.js) and
// Chrome's --remote-allow-origins (scripts/start.sh) must name the EXACT same
// loopback host. Chrome's allowlist is an exact scheme://host:port match against
// the WebSocket handshake Origin; a localhost↔127.0.0.1 mismatch 403s the
// handshake and the watcher never reads. This guards against future drift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCdpPageSource, hasCartContent, familyNameToken } from '../src/chrome.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const fixture = (name) => read(join('test/fixtures', name));

// A minimal fake CDP page: goto() returns a fixed status; evaluate() returns the
// NEXT scripted body text (so we can model a challenge that clears on reload). A
// scripted body that is an Error is THROWN — modelling an execution-context-
// destroyed race while Cloudflare auto-navigates. click() records its selector
// on page.clicked (so tests can assert the generation-toggle fallback fired or
// stayed quiet) and throws clickError when scripted — modelling a generation
// box that is absent/hidden (Playwright's click times out).
function fakePage({ status = 200, bodies = [''], clickError = null } = {}) {
  let i = 0;
  const clicked = [];
  return {
    clicked,
    isClosed: () => false,
    goto: async () => ({ status: () => status }),
    click: async (selector) => {
      clicked.push(selector);
      if (clickError) throw clickError;
    },
    evaluate: async () => {
      const v = bodies[Math.min(i, bodies.length - 1)];
      i += 1;
      if (v instanceof Error) throw v;
      return v;
    },
  };
}
const LAX_AN5 = { key: 'lax/an5', regionSlug: 'los-angeles', gen: 'an5' };
const HKG_AN5 = { key: 'hkg/an5', regionSlug: 'hong-kong', gen: 'an5', locCode: 'HKG', genLabel: 'AN5' };

// The DMIT deep-link bug render: cart anchors present, but the page opened on
// the region's DEFAULT generation (AS3) instead of the requested one.
const HKG_WRONG_GEN = 'Instance Scale HKG.AS3.Pro.TINY $39.90 Out of Stock Total Due Today';
const HKG_RIGHT_GEN = 'Instance Scale HKG.AN5.Pro.MINI $149.90 Add to Cart Total Due Today';

test('the CDP connect endpoint default pins 127.0.0.1 (not localhost)', () => {
  const src = read('src/chrome.js');
  const m = src.match(/endpoint\s*=\s*'(http:\/\/[^']+)'/);
  assert.ok(m, 'could not find the default endpoint literal in src/chrome.js');
  assert.match(m[1], /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.doesNotMatch(m[1], /localhost/);
});

test('the watcher builds its CDP endpoint on 127.0.0.1 (not localhost)', () => {
  const src = read('src/watcher.js');
  const m = src.match(/endpoint:\s*settings\.chromeDebugPort\s*\?\s*`(http:\/\/[^`]+)`/);
  assert.ok(m, 'could not find the watcher endpoint template in src/watcher.js');
  assert.match(m[1], /^http:\/\/127\.0\.0\.1:\$\{settings\.chromeDebugPort\}$/);
  assert.doesNotMatch(m[1], /localhost/);
});

test('start.sh --remote-allow-origins host matches the connect endpoint host', () => {
  const sh = read('scripts/start.sh');
  const allow = sh.match(/--remote-allow-origins="http:\/\/([0-9.]+):/);
  assert.ok(allow, 'could not find --remote-allow-origins in scripts/start.sh');
  const allowHost = allow[1];
  assert.equal(allowHost, '127.0.0.1');

  const chrome = read('src/chrome.js');
  const endpointHost = chrome.match(/endpoint\s*=\s*'http:\/\/([0-9.]+):/)[1];
  assert.equal(endpointHost, allowHost, 'connect endpoint host must equal --remote-allow-origins host');
});

test('start.sh binds the debug port to 127.0.0.1 explicitly', () => {
  const sh = read('scripts/start.sh');
  assert.match(sh, /--remote-debugging-address=127\.0\.0\.1/);
});

test('createCdpPageSource constructs without a port source and exposes familyUrl', () => {
  // No network/Playwright touched (connect is lazy) — just proves the factory API.
  const src = createCdpPageSource({ settings: { baseUrl: 'https://www.dmit.io' } });
  assert.equal(typeof src.readFamily, 'function');
  assert.match(src.familyUrl({ regionSlug: 'los-angeles', gen: 'as3' }), /cart\.php/);
});

// ---- start.sh runs Chrome headless with a realistic (non-Headless) UA ----

test('start.sh launches Chrome headless (--headless=new) with no visible window', () => {
  const sh = read('scripts/start.sh');
  assert.match(sh, /--headless=new/, 'start.sh must launch Chrome with --headless=new');
});

test('start.sh passes a realistic desktop UA with NO HeadlessChrome token', () => {
  const sh = read('scripts/start.sh');
  assert.match(sh, /--user-agent=/, 'start.sh must set a --user-agent');
  // The CF-passing UA must be a normal Chrome UA, never advertise HeadlessChrome.
  const ua = sh.match(/CHROME_UA="\$\{DMIT_WATCH_CHROME_UA:-([^"}]+)\}"/);
  assert.ok(ua, 'could not find the CHROME_UA default in start.sh');
  assert.match(ua[1], /Mozilla\/5\.0.*Chrome\/\d+.*Safari/);
  assert.doesNotMatch(ua[1], /Headless/i);
});

// ---- hasCartContent: tells a real cart render from a Cloudflare challenge ----

test('hasCartContent is true for a sold-out cart render', () => {
  assert.equal(hasCartContent(fixture('all-out.txt')), true);
});

test('hasCartContent is true for an orderable cart render', () => {
  assert.equal(hasCartContent(fixture('orderable.synthetic.txt')), true);
});

test('hasCartContent is false for a Cloudflare challenge interstitial', () => {
  assert.equal(hasCartContent(fixture('cf-challenge.txt')), false);
});

test('hasCartContent matches on a plan name even before stock markers paint', () => {
  assert.equal(hasCartContent('… LAX.AN5.Pro.MINI …', { plans: [{ name: 'LAX.AN5.Pro.MINI' }] }), true);
  assert.equal(hasCartContent('Just a moment...', { plans: [{ name: 'LAX.AN5.Pro.MINI' }] }), false);
});

// ---- readFamily tolerates a transient CF challenge instead of bailing ----

test('readFamily waits out a transient challenge then reads the real cart (ok=true)', async () => {
  // goto returns 403 (the challenge); first body is the interstitial, the reload
  // shows the real sold-out cart. Old code bailed on status; new code waits.
  const page = fakePage({ status: 403, bodies: [fixture('cf-challenge.txt'), fixture('all-out.txt')] });
  const src = createCdpPageSource({
    connect: async () => ({ browser: { close: async () => {} }, page }),
    sleep: async () => {}, // instant — no real delay in tests
  });
  const res = await src.readFamily(LAX_AN5);
  assert.equal(res.ok, true, 'a cleared challenge must read as ok');
  assert.equal(res.status, 403, 'raw goto status is preserved for diagnostics');
  assert.match(res.pageText, /LAX\.AN5\.Pro\.MINI/);
  assert.match(res.pageText, /Out of Stock/);
});

test('readFamily survives an evaluate that throws mid-navigation (CF auto-reload race)', async () => {
  // The challenge clears via a full navigation: the first evaluate races into a
  // destroyed execution context (throws), the reload then renders the real cart.
  const ctxDestroyed = new Error('Execution context was destroyed, most likely because of a navigation');
  const page = fakePage({ status: 403, bodies: [ctxDestroyed, fixture('all-out.txt')] });
  const src = createCdpPageSource({
    connect: async () => ({ browser: { close: async () => {} }, page }),
    sleep: async () => {},
  });
  const res = await src.readFamily(LAX_AN5);
  assert.equal(res.ok, true, 'a transient evaluate throw must not bail — keep polling');
  assert.equal(res.chromeState, 'UP');
  assert.match(res.pageText, /LAX\.AN5\.Pro\.GIANT/);
});

test('readFamily returns the page as-is (ok=false) when the challenge never clears', async () => {
  const page = fakePage({ status: 403, bodies: [fixture('cf-challenge.txt')] });
  const src = createCdpPageSource({
    connect: async () => ({ browser: { close: async () => {} }, page }),
    sleep: async () => {},
    contentTimeoutMs: -1, // force the deadline to pass immediately (one read, no wait)
  });
  const res = await src.readFamily(LAX_AN5);
  assert.equal(res.ok, false, 'a persistent challenge is NOT ok (detect → UNKNOWN, blind net fires)');
  assert.match(res.pageText, /Just a moment/);
});

// ---- generation-toggle fallback: the DMIT ?generation= deep-link bug ----

test('familyNameToken derives LOC.GEN. from a DMIT family and null otherwise', () => {
  assert.equal(familyNameToken(HKG_AN5), 'hkg.an5.');
  assert.equal(familyNameToken(LAX_AN5), null); // no locCode/genLabel — fallback disabled
  assert.equal(familyNameToken(null), null);
});

test('readFamily clicks the generation box when the cart opened on the wrong generation', async () => {
  const page = fakePage({ bodies: [HKG_WRONG_GEN, HKG_RIGHT_GEN] });
  const src = createCdpPageSource({
    connect: async () => ({ browser: { close: async () => {} }, page }),
    sleep: async () => {},
  });
  const res = await src.readFamily(HKG_AN5);
  assert.deepEqual(page.clicked, ['.server-generation-box[generation="AN5"]:not(.hidden)']);
  assert.equal(res.ok, true);
  assert.match(res.pageText, /HKG\.AN5\.Pro\.MINI/, 'must return the switched render');
});

test('readFamily never clicks when the requested generation already rendered', async () => {
  const page = fakePage({ bodies: [HKG_RIGHT_GEN] });
  const src = createCdpPageSource({
    connect: async () => ({ browser: { close: async () => {} }, page }),
    sleep: async () => {},
  });
  const res = await src.readFamily(HKG_AN5);
  assert.deepEqual(page.clicked, []);
  assert.equal(res.ok, true);
  assert.match(res.pageText, /HKG\.AN5\.Pro\.MINI/);
});

test('readFamily returns the mismatched render as-is when the box is unclickable', async () => {
  // DMIT pulls the generation again: the box is gone/hidden, the click times
  // out — the read must stay ok (cart is real) and detect.js goes UNKNOWN.
  const page = fakePage({ bodies: [HKG_WRONG_GEN], clickError: new Error('click: Timeout 5000ms exceeded') });
  const src = createCdpPageSource({
    connect: async () => ({ browser: { close: async () => {} }, page }),
    sleep: async () => {},
  });
  const res = await src.readFamily(HKG_AN5);
  assert.equal(page.clicked.length, 1, 'the fallback was attempted');
  assert.equal(res.ok, true);
  assert.equal(res.chromeState, 'UP');
  assert.match(res.pageText, /HKG\.AS3\.Pro\.TINY/, 'the original render is preserved');
});

test('readFamily never clicks for a family without locCode/genLabel', async () => {
  // Legacy/non-DMIT family shapes carry no name-token fields — the fallback
  // must stay fully inert even when the text matches nothing.
  const page = fakePage({ bodies: [HKG_WRONG_GEN] });
  const src = createCdpPageSource({
    connect: async () => ({ browser: { close: async () => {} }, page }),
    sleep: async () => {},
  });
  const res = await src.readFamily(LAX_AN5);
  assert.deepEqual(page.clicked, []);
  assert.equal(res.ok, true);
});

test('readFamily does not click when the page is not a cart render (CF challenge)', async () => {
  const page = fakePage({ bodies: [fixture('cf-challenge.txt')] });
  const src = createCdpPageSource({
    connect: async () => ({ browser: { close: async () => {} }, page }),
    sleep: async () => {},
    contentTimeoutMs: -1, // one read, no wait
  });
  const res = await src.readFamily(HKG_AN5);
  assert.deepEqual(page.clicked, [], 'nothing to click on an interstitial');
  assert.equal(res.ok, false);
});

test('readFamily reports DOWN + ok=false when the connect/goto throws', async () => {
  const src = createCdpPageSource({
    connect: async () => {
      throw new Error('connectOverCDP ECONNREFUSED');
    },
    logger: { warn() {} },
  });
  const res = await src.readFamily(LAX_AN5);
  assert.equal(res.ok, false);
  assert.equal(res.chromeState, 'DOWN');
  assert.match(res.error, /ECONNREFUSED/);
});
