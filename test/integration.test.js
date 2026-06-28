// INTEGRATION: the watcher driven by a FAKE CDP page source, wired to a real
// in-memory store and the real panel server, asserted through the live
// /api/state HTTP surface. Plus the session-loss / CDP-attach recovery path.
//
//   watcher (fake CDP) → store(:memory:) → GET /api/state
//
// No Chrome, no Telegram, no real config writes — the watchlist is read-only here.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWatcher } from '../src/watcher.js';
import { createPanelServer } from '../src/server.js';
import { openStore } from '../src/store.js';
import { loadWatchlist } from '../src/config.js';
import { readFixture, makeFixtureSource } from './helpers.js';

const FAM = 'lax/an5';
const SILENT = { log() {}, warn() {}, error() {} };

let store;
let server;
let watcher;
let base;
let page; // mutable fixture the fake source returns for FAM

before(async () => {
  const wl = loadWatchlist();
  store = openStore(':memory:');
  store.seedFromWatchlist(wl);
  store.touchHeartbeat({ chromeSession: 'UP' });

  page = readFixture('all-out.txt');
  const source = makeFixtureSource({ [FAM]: () => ({ ok: true, status: 200, pageText: page }) });
  watcher = createWatcher({ store, watchlist: wl, pageSource: source, logger: SILENT });

  server = createPanelServer({ store, watchlist: wl, port: 0, logger: SILENT });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.stop();
  store.close();
});

const apiState = async () => {
  const r = await fetch(base + '/api/state');
  assert.ok(r.ok);
  return r.json();
};
const flat = (s) => s.datacenters.flatMap((dc) => dc.generations.flatMap((g) => g.plans));
const planFromApi = (s, id) => flat(s).find((p) => p.id === id);

test('all-OUT poll → /api/state shows 33 plans, every one waiting/out', async () => {
  await watcher.pollFamily(FAM);
  const s = await apiState();
  assert.equal(flat(s).length, 33);
  assert.equal(s.counts.in, 0);
  assert.equal(planFromApi(s, 'lax-an5-mini').status, 'out');
});

test('restock poll → the plan surfaces as IN through /api/state', async () => {
  page = readFixture('orderable.synthetic.txt'); // MINI restocks
  const summary = await watcher.pollFamily(FAM);
  assert.deepEqual(summary.fired, ['lax-an5-mini']);

  const s = await apiState();
  assert.equal(planFromApi(s, 'lax-an5-mini').status, 'in');
  assert.equal(s.counts.in, 1);
  // the API carries a working buy link for the now-orderable plan
  assert.match(planFromApi(s, 'lax-an5-mini').deepLink, /cart\.php.*generation=an5/);
});

test('a CDP read error (readFamily throws) is absorbed: health DOWN, no false IN', async () => {
  const wl = loadWatchlist();
  const localStore = openStore(':memory:');
  localStore.seedFromWatchlist(wl);
  let mode = 'ok';
  const flaky = {
    async readFamily() {
      if (mode === 'throw') throw new Error('connectOverCDP ECONNREFUSED');
      return { ok: true, status: 200, pageText: readFixture('all-out.txt'), chromeState: 'UP' };
    },
    async close() {},
  };
  const w = createWatcher({ store: localStore, watchlist: wl, pageSource: flaky, logger: SILENT });

  await w.pollFamily(FAM); // healthy baseline
  assert.equal(localStore.getFamilyHealth(FAM).chrome_state, 'UP');

  mode = 'throw';
  const s = await w.pollFamily(FAM); // CDP drop mid-run
  assert.equal(s.outcome, 'err');
  assert.deepEqual(s.fired, []);
  assert.equal(localStore.getFamilyHealth(FAM).chrome_state, 'DOWN');
  assert.equal(localStore.getPlan('lax-an5-mini').status, 'UNKNOWN'); // never IN
  assert.equal(localStore.getPlan('lax-an5-mini').last_known, 'OUT'); // edge basis intact

  // recovery: a clean read flips health back UP and clears backoff, no alert
  mode = 'ok';
  const s2 = await w.pollFamily(FAM);
  assert.equal(s2.outcome, 'ok');
  assert.deepEqual(s2.fired, []);
  assert.equal(localStore.getFamilyHealth(FAM).chrome_state, 'UP');
  assert.equal(localStore.getFamilyHealth(FAM).backoff_level, 0);
  localStore.close();
});
