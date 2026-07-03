// WHMCS provider tests: the pure classifier over the captured qq.pw fixture,
// the fetch-based page source (fully mocked), and the watcher end-to-end via
// provider routing.  node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STOCK } from '../src/detect.js';
import { htmlToText, classifyWhmcsFamily, createHttpPageSource } from '../src/whmcs.js';
import { createWatcher } from '../src/watcher.js';
import { openStore } from '../src/store.js';
import { loadWatchlist } from '../src/config.js';
import { readFixture, makeFixtureSource } from './helpers.js';

const wl = loadWatchlist();
const FAM = 'hnl/vds';
const family = wl.families.find((f) => f.key === FAM);
const plans = wl.plans.filter((p) => p.family === FAM);
const statusOf = (det, id) => det.results.find((r) => r.id === id).stock;

test('htmlToText strips scripts/styles/tags and decodes entities', () => {
  const text = htmlToText(
    '<script>alert(1)</script><style>.x{}</style><div>A &amp; B</div><span>&#39;q&#39;</span>',
  );
  assert.equal(text, "A & B\n'q'");
  assert.doesNotMatch(text, /alert/);
});

test('qq.pw fixture: all four plans OUT via the explicit "0 Available" badge', () => {
  const det = classifyWhmcsFamily({ pageText: readFixture('qqpw-store.txt'), family, plans });
  assert.equal(det.markersPresent, true);
  assert.equal(det.countMatch, true);
  assert.equal(det.controlOutCount, 4);
  for (const r of det.results) {
    assert.equal(r.stock, STOCK.OUT, `${r.name} should be OUT`);
    assert.equal(r.reason, 'qty:0');
  }
});

test('restock: a positive quantity flips exactly that plan to IN', () => {
  // First badge on the page belongs to Intern.
  const restocked = readFixture('qqpw-store.txt').replace('0 Available', '3 Available');
  const det = classifyWhmcsFamily({ pageText: restocked, family, plans });
  assert.equal(statusOf(det, 'hnl-vds-intern'), STOCK.IN);
  assert.equal(det.results.find((r) => r.id === 'hnl-vds-intern').reason, 'qty:3');
  assert.equal(statusOf(det, 'hnl-vds-reliable'), STOCK.OUT);
  assert.equal(statusOf(det, 'hnl-vds-elite'), STOCK.OUT);
});

test('a missing badge is UNKNOWN (never IN), other cards still classify', () => {
  // Drop only Intern's badge; the other three keep theirs.
  const broken = readFixture('qqpw-store.txt').replace('0 Available', '');
  const det = classifyWhmcsFamily({ pageText: broken, family, plans });
  const intern = det.results.find((r) => r.id === 'hnl-vds-intern');
  assert.equal(intern.stock, STOCK.UNKNOWN);
  assert.equal(intern.reason, 'qty-missing');
  assert.equal(statusOf(det, 'hnl-vds-reliable'), STOCK.OUT);
});

test('an untrustworthy page (CF challenge / no badges at all) is all-UNKNOWN', () => {
  const blocked = classifyWhmcsFamily({ pageText: 'Just a moment...', family, plans });
  assert.equal(blocked.markersPresent, false);
  for (const r of blocked.results) {
    assert.equal(r.stock, STOCK.UNKNOWN);
    assert.equal(r.reason, 'blocked');
  }

  const noBadges = readFixture('qqpw-store.txt').replace(/\d+\s*Available/gi, '');
  const det = classifyWhmcsFamily({ pageText: noBadges, family, plans });
  assert.equal(det.markersPresent, false);
  for (const r of det.results) assert.equal(r.stock, STOCK.UNKNOWN);
});

test('createHttpPageSource: ok, http error, thrown error, missing url', async () => {
  const okFetch = async () => ({ ok: true, status: 200, text: async () => '<b>Dedicate IP VDS Intern</b> 0 Available' });
  const src = createHttpPageSource({ fetchImpl: okFetch, logger: { warn() {} } });
  const read = await src.readFamily(family);
  assert.equal(read.ok, true);
  assert.match(read.pageText, /Dedicate IP VDS Intern/);
  assert.equal(read.chromeState, null); // never touches the Chrome lamp

  const err503 = createHttpPageSource({ fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }), logger: { warn() {} } });
  const r503 = await err503.readFamily(family);
  assert.equal(r503.ok, false);
  assert.equal(r503.status, 503);

  const boom = createHttpPageSource({ fetchImpl: async () => { throw new Error('ECONNRESET'); }, logger: { warn() {} } });
  const rBoom = await boom.readFamily(family);
  assert.equal(rBoom.ok, false);
  assert.match(rBoom.error, /ECONNRESET/);

  const noUrl = await boom.readFamily({ key: 'x/y' });
  assert.equal(noUrl.ok, false);
  assert.match(noUrl.error, /no url/);
});

test('watcher end-to-end: qq.pw 0→3 Available fires the edge with the product deep link', async () => {
  let page = readFixture('qqpw-store.txt');
  const store = openStore(':memory:');
  store.seedFromWatchlist(wl);
  const watcher = createWatcher({
    store,
    watchlist: wl,
    pageSource: makeFixtureSource({ [FAM]: () => ({ ok: true, status: 200, pageText: page }) }),
  });
  const edges = [];
  watcher.on('edge', (e) => edges.push(e));

  const s1 = await watcher.pollFamily(FAM); // all OUT — no control group needed
  assert.deepEqual(s1.fired, []);
  assert.equal(store.getPlan('hnl-vds-intern').status, 'OUT');

  page = page.replace('0 Available', '2 Available'); // Intern restocks
  const s2 = await watcher.pollFamily(FAM);
  assert.deepEqual(s2.fired, ['hnl-vds-intern']);
  assert.equal(edges.length, 1);
  assert.equal(
    edges[0].deepLink,
    'https://qq.pw/store/residential-vds-with-dedicated-ip/dedicate-ip-vds-entry',
  );
  assert.equal(store.getPlan('hnl-vds-intern').status, 'IN');
  assert.equal(store.transitionsForPlan('hnl-vds-intern').length, 1);
  store.close();
});
