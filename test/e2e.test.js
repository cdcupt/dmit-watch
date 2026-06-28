// E2E-ish: the WHOLE stack against a fake DMIT origin, driven deterministically.
//
//   watcher (fake CDP) → scheduler (real fan-out) → Telegram (mocked fetch)
//                                                  ↘ broadcast → panel server → /api/state
//
// One fixture flips a plan OUT→IN and back. We assert: an edge fires once, the
// mocked Telegram payload carries the deep link, the plan reads IN via /api/state
// AND rings the on-panel alarm, a SKU that stays IN never re-fires, a flap to OUT
// re-arms (no telegram), the next restock fires again, and an all-OUT steady
// state produces zero alerts on any channel. (TECH §18.)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createWatcher } from '../src/watcher.js';
import { createScheduler } from '../src/scheduler.js';
import { createTelegramNotifier } from '../src/telegram.js';
import { createPanelServer } from '../src/server.js';
import { openStore } from '../src/store.js';
import { loadWatchlist } from '../src/config.js';
import { readFixture, makeFixtureSource } from './helpers.js';

const FAM = 'lax/an5';
const PLAN = 'lax-an5-mini';
const SILENT = { log() {}, warn() {}, error() {} };
const SECRETS = { botToken: 'E2EBOTTOKEN', chatId: '999000' };

let store;
let server;
let watcher;
let scheduler;
let base;
let page; // mutable fixture returned for FAM
let tgCalls; // captured Telegram sendMessage bodies
let clock; // injectable epoch-ms clock so cadence/cooldown are deterministic

before(async () => {
  const wl = loadWatchlist();
  store = openStore(':memory:');
  store.seedFromWatchlist(wl);
  store.touchHeartbeat({ chromeSession: 'UP' });

  // fake DMIT origin: returns whatever `page` currently holds for FAM
  page = readFixture('all-out.txt');
  const source = makeFixtureSource({ [FAM]: () => ({ ok: true, status: 200, pageText: page }) });

  // mocked Telegram Bot API — record every send, always 200 OK
  tgCalls = [];
  const fetchMock = async (url, init) => {
    tgCalls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: tgCalls.length } }) };
  };

  server = createPanelServer({ store, watchlist: wl, port: 0, logger: SILENT });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;

  const notifier = createTelegramNotifier({
    secrets: SECRETS,
    store,
    fetch: fetchMock,
    sleep: async () => {},
    logger: SILENT,
  });

  clock = 1_700_000_000_000; // fixed base epoch
  watcher = createWatcher({ store, watchlist: wl, pageSource: source, now: () => clock, logger: SILENT });
  scheduler = createScheduler({
    watcher,
    notifier,
    store,
    broadcast: (event, payload) => server.broadcast(event, payload),
    logger: SILENT,
  });

  // Wire the real fan-out (edge→telegram + broadcast), then freeze the cadence so
  // we drive polls deterministically by hand — the scheduler's listeners stay live.
  scheduler.start();
  await watcher.stop(); // clears the per-family timers; emitter wiring is untouched
});

after(async () => {
  await scheduler.stop();
  await server.stop();
  store.close();
});

const apiState = async () => (await fetch(base + '/api/state')).json();
const flat = (s) => s.datacenters.flatMap((dc) => dc.generations.flatMap((g) => g.plans));
const apiPlan = async (id) => flat(await apiState()).find((p) => p.id === id);

// Advance the injectable clock by one cadence (default ~75s) before each poll, so
// cooldown/transition timing matches a real ~60–90s loop instead of 0ms apart.
async function pollSettled(gapMs = 75_000) {
  clock += gapMs;
  await watcher.pollFamily(FAM);
  await scheduler.whenIdle(); // let any edge→telegram send finish + log
}

test('all-OUT steady state: repeated polls produce zero alerts on any channel', async () => {
  await pollSettled();
  await pollSettled();
  assert.equal(tgCalls.length, 0);
  const p = await apiPlan(PLAN);
  assert.equal(p.status, 'out');
  assert.equal(p.alarm, false);
  assert.equal((await apiState()).counts.in, 0);
});

test('restock OUT→IN: one edge → Telegram payload + alarm + IN via /api/state', async () => {
  page = readFixture('orderable.synthetic.txt');
  await pollSettled();

  // exactly one Telegram message, carrying the cart.php deep link
  assert.equal(tgCalls.length, 1);
  const sent = tgCalls[0];
  assert.ok(sent.url.includes('/botE2EBOTTOKEN/sendMessage'));
  assert.equal(sent.body.chat_id, '999000');
  assert.match(sent.body.text, /IN STOCK — LAX\.AN5\.Pro\.MINI/);
  assert.match(sent.body.text, /cart\.php\?region=los-angeles&network=premium&generation=an5/);

  // the same edge rang the on-panel alarm and flipped /api/state to IN
  const p = await apiPlan(PLAN);
  assert.equal(p.status, 'in');
  assert.equal(p.alarm, true);
  assert.equal((await apiState()).counts.in, 1);

  // a delivery row was logged
  const row = store.recentTelegram(1)[0];
  assert.equal(row.plan_id, PLAN);
  assert.equal(row.sent_ok, 1);
});

test('stays IN across cycles: no re-fire (still exactly one Telegram total)', async () => {
  await pollSettled();
  await pollSettled();
  assert.equal(tgCalls.length, 1); // unchanged
  assert.equal((await apiPlan(PLAN)).status, 'in');
});

test('flap IN→OUT: re-arm is state-only (no telegram), plan reads OUT again', async () => {
  page = readFixture('all-out.txt');
  await pollSettled();
  assert.equal(tgCalls.length, 1); // re-arm never buzzes the phone
  const p = await apiPlan(PLAN);
  assert.equal(p.status, 'out');
  assert.equal(p.alarm, false); // alarm cleared on re-arm
  assert.equal(store.getPlan(PLAN).armed, 1); // re-armed for the next edge
});

test('second restock fires again: two edges → two Telegram messages', async () => {
  page = readFixture('orderable.synthetic.txt');
  // jump past the anti-flap cooldown (cooldownSec: 90) so the genuine second
  // edge is allowed to alert — a real restock later, not a millisecond flap.
  await pollSettled(700_000);
  assert.equal(tgCalls.length, 2);
  assert.equal((await apiPlan(PLAN)).status, 'in');
});
