// Publisher + push-config unit tests (public-stock-page TECH §14: CFG-U1..U5,
// PUB-U1..U10). Fully injected — fake fetch (captureFetch idiom from
// telegram.test.js), injected clock, ~1-15 ms debounce instead of the real 3 s.
// NEVER touches the network, real timers beyond a few ms, or ~/.dmit-watch.
// The token in every test is a sentinel string, never a real secret.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import { createPublisher } from '../src/publisher.js';
import { loadPushConfig, loadWatchlist, removeFamilyFromWatchlist } from '../src/config.js';
import { wireNotifier, wirePublisher } from '../src/index.js';
import { openStore } from '../src/store.js';

const TOKEN = 'TESTPUSHTOKEN-cafe42';
const PUSH_URL = 'https://vps-stock.example.com/api/push';
const CONFIG = { url: PUSH_URL, token: TOKEN };
const SILENT = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function seededStore() {
  const store = openStore(':memory:');
  store.seedFromWatchlist(loadWatchlist());
  store.touchHeartbeat({ chromeSession: 'UP' });
  return store;
}

/** Recording logger — every line kept for token-leak scans + exact-line asserts. */
function recordingLogger() {
  const lines = [];
  const rec = () => (...args) => lines.push(args.join(' '));
  return { lines, log: rec(), warn: rec(), error: rec() };
}

/** captureFetch (telegram.test.js idiom): record calls, script the outcomes. */
function captureFetch({ failTimes = 0, status = 502, hang = false, reject = false } = {}) {
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    n += 1;
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (hang) return new Promise(() => {}); // never settles
    if (reject) throw new Error('network down');
    if (n <= failTimes) return { ok: false, status };
    return { ok: true, status: 200 };
  };
  return { fetch, calls };
}

/** Publisher under test with an injectable clock + live-swappable watchlist. */
function makePublisher({ store, fetch, logger = SILENT, debounceMs = 1, config = CONFIG, cadenceSec } = {}) {
  let clock = 1_700_000_000_000;
  let wl = loadWatchlist();
  const pub = createPublisher({
    config,
    getWatchlist: () => wl,
    store,
    cadenceSec,
    fetch,
    logger,
    now: () => clock,
    debounceMs,
  });
  return {
    pub,
    clockNow: () => clock,
    tick: (ms) => { clock += ms; },
    setWatchlist: (next) => { wl = next; },
  };
}

// ---- loadPushConfig matrix (CFG-U1..U4) ------------------------------------

function withPushFile(content) {
  const f = join(tmpdir(), `dmit-push-${process.pid}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(f, content);
  return f;
}
const NO_FILE = join(tmpdir(), 'dmit-push-does-not-exist');

test('loadPushConfig: both keys present + valid https URL → {url, token}, no log noise', () => {
  const logger = recordingLogger();
  const f = withPushFile(`DMIT_WATCH_PUSH_URL=${PUSH_URL}\nDMIT_WATCH_PUSH_TOKEN=${TOKEN}\n`);
  try {
    const cfg = loadPushConfig({ env: {}, file: f, logger });
    assert.deepEqual(cfg, { url: PUSH_URL, token: TOKEN });
    assert.equal(logger.lines.length, 0);
  } finally {
    rmSync(f, { force: true });
  }
});

test('loadPushConfig: env overrides the file (same precedence as loadSecrets)', () => {
  const f = withPushFile(`DMIT_WATCH_PUSH_URL=https://file-value.example.com/api/push\nDMIT_WATCH_PUSH_TOKEN=filetoken\n`);
  try {
    const cfg = loadPushConfig({
      env: { DMIT_WATCH_PUSH_URL: PUSH_URL, DMIT_WATCH_PUSH_TOKEN: TOKEN },
      file: f,
      logger: SILENT,
    });
    assert.deepEqual(cfg, { url: PUSH_URL, token: TOKEN });
  } finally {
    rmSync(f, { force: true });
  }
});

test('loadPushConfig: neither key present → null, silently (public-repo default)', () => {
  const logger = recordingLogger();
  assert.equal(loadPushConfig({ env: {}, file: NO_FILE, logger }), null);
  assert.equal(logger.lines.length, 0);
});

test('loadPushConfig: exactly one key present → null + a warn naming the missing key', () => {
  for (const [env, missing] of [
    [{ DMIT_WATCH_PUSH_URL: PUSH_URL }, 'DMIT_WATCH_PUSH_TOKEN'],
    [{ DMIT_WATCH_PUSH_TOKEN: TOKEN }, 'DMIT_WATCH_PUSH_URL'],
  ]) {
    const logger = recordingLogger();
    assert.equal(loadPushConfig({ env, file: NO_FILE, logger }), null);
    assert.equal(logger.lines.length, 1);
    assert.ok(logger.lines[0].includes(missing), `warn should name ${missing}`);
    assert.ok(!logger.lines[0].includes(TOKEN), 'token value never logged');
  }
});

test('loadPushConfig: malformed or non-http(s) URL → null + warn, never throws', () => {
  for (const url of ['not a url at all', 'ftp://example.com/push']) {
    const logger = recordingLogger();
    const cfg = loadPushConfig({
      env: { DMIT_WATCH_PUSH_URL: url, DMIT_WATCH_PUSH_TOKEN: TOKEN },
      file: NO_FILE,
      logger,
    });
    assert.equal(cfg, null);
    assert.equal(logger.lines.length, 1);
    assert.match(logger.lines[0], /push disabled/);
    assert.ok(!logger.lines[0].includes(TOKEN));
  }
});

// ---- publisher: disabled no-op ----------------------------------------------

test('publisher: config null → callable no-op, enabled:false, never fetches', async () => {
  const { fetch, calls } = captureFetch();
  const pub = createPublisher({ config: null, fetch });
  assert.equal(pub.enabled, false);
  pub.onEvent('family', {}); // must not throw, must not arm anything
  await pub.whenIdle();
  await pub.stop();
  assert.equal(calls.length, 0);
});

// ---- publisher: send path (PUB-U1..U4) --------------------------------------

test('publisher: envelope + headers exact — {v:1, pushedAt: injected now, state} + Bearer', async () => {
  const store = seededStore();
  const { fetch, calls } = captureFetch();
  const { pub, clockNow } = makePublisher({ store, fetch });

  pub.onEvent('family', {});
  await pub.whenIdle();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PUSH_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  const body = calls[0].body;
  assert.equal(body.v, 1);
  assert.equal(body.pushedAt, clockNow());
  assert.equal(body.state.counts.total, 37);
  store.close();
});

// PUB-U11 (subscriptions TECH §B6/D7 + Q1.8): the envelope gains cadenceSec as an
// OPTIONAL field — present with the resolved target when the option is passed,
// absent (old shape byte-identical) when it is not. v stays 1 either way.
test('publisher: cadenceSec option → {v:1, pushedAt, cadenceSec: 300, state}; omitted → no cadenceSec key', async () => {
  const store = seededStore();

  // With cadenceSec: 300 — the field rides the envelope, v stays 1.
  const withCad = captureFetch();
  const a = makePublisher({ store, fetch: withCad.fetch, cadenceSec: 300 });
  a.pub.onEvent('family', {});
  await a.pub.whenIdle();
  const body = withCad.calls[0].body;
  assert.deepEqual(Object.keys(body), ['v', 'pushedAt', 'cadenceSec', 'state']);
  assert.equal(body.v, 1, 'optional-field addition, never a version bump');
  assert.equal(body.pushedAt, a.clockNow());
  assert.equal(body.cadenceSec, 300);
  assert.equal(body.state.counts.total, 37);

  // Option omitted — the round-1 shape, byte-identical (no cadenceSec key at all).
  const without = captureFetch();
  const b = makePublisher({ store, fetch: without.fetch });
  b.pub.onEvent('family', {});
  await b.pub.whenIdle();
  const old = without.calls[0].body;
  assert.ok(!('cadenceSec' in old), 'omitting the option emits no cadenceSec key');
  assert.deepEqual(Object.keys(old), ['v', 'pushedAt', 'state']);
  store.close();
});

test('publisher: privacy filter — watcher key + lastCheckMs stripped, alarm false everywhere', async () => {
  const store = seededStore();
  const ts = Date.now();
  // A live IN plan that the LOCAL panel would ring the alarm for.
  store.setPlanState('lax-an4-medium', { status: 'IN', lastKnown: 'IN', lastChecked: ts, lastChange: ts });
  const { fetch, calls } = captureFetch();
  const { pub } = makePublisher({ store, fetch });

  pub.onEvent('family', {});
  await pub.whenIdle();

  const state = calls[0].body.state;
  assert.equal(state.watcher, undefined, 'operator watcher block must not be on the wire');
  const flat = state.datacenters.flatMap((dc) => dc.generations.flatMap((g) => g.plans));
  assert.equal(flat.length, 37);
  assert.ok(flat.every((p) => !('lastCheckMs' in p)), 'per-plan poll timing stripped');
  assert.ok(flat.every((p) => p.alarm === false), 'alarm:false even for the IN plan');
  const inPlan = flat.find((p) => p.id === 'lax-an4-medium');
  assert.equal(inPlan.status, 'in');
  assert.equal(inPlan.inSinceMs, ts); // public fields survive the filter
  store.close();
});

test('publisher: debounce coalesces a burst of family events into one send', async () => {
  const store = seededStore();
  const { fetch, calls } = captureFetch();
  const { pub } = makePublisher({ store, fetch, debounceMs: 15 });

  for (let i = 0; i < 5; i += 1) pub.onEvent('family', {});
  pub.onEvent('edge', {}); // non-family events are ignored entirely
  await pub.whenIdle();

  assert.equal(calls.length, 1);
  store.close();
});

test('publisher: payload reads the LIVE watchlist, not a boot copy', async () => {
  const store = seededStore();
  const { fetch, calls } = captureFetch();
  const { pub, setWatchlist } = makePublisher({ store, fetch });

  pub.onEvent('family', {});
  await pub.whenIdle();
  setWatchlist(removeFamilyFromWatchlist(loadWatchlist(), 'hkg/an5')); // panel /api/watchlist/remove
  pub.onEvent('family', {});
  await pub.whenIdle();

  const gens = (body) => body.state.datacenters.flatMap((dc) => dc.generations.map((g) => g.key));
  assert.ok(gens(calls[0].body).includes('hkg/an5'), 'first push still carries the family');
  assert.ok(!gens(calls[1].body).includes('hkg/an5'), 'second push reflects the removal');
  store.close();
});

// ---- publisher: in-flight skip + failure isolation (PUB-U5..U8) -------------

test('publisher: in-flight skip — no queue, no second call, skip counter bumps', async () => {
  const store = seededStore();
  const { fetch, calls } = captureFetch({ hang: true });
  const { pub } = makePublisher({ store, fetch });

  pub.onEvent('family', {});
  await sleep(5); // let the timer fire and the hanging send start
  assert.equal(calls.length, 1);
  pub.onEvent('family', {});
  await sleep(5); // timer fires again → in-flight → skipped outright
  assert.equal(calls.length, 1);
  assert.equal(pub._state.skippedInFlight, 1);
  await pub.stop(); // abort the hanging fetch so nothing outlives the test
  store.close();
});

test('publisher: throwing fetch never rejects outward; next family event retries', async () => {
  const store = seededStore();
  const { fetch, calls } = captureFetch({ reject: true });
  const { pub } = makePublisher({ store, fetch });
  const rejections = [];
  const onReject = (r) => rejections.push(r);
  process.on('unhandledRejection', onReject);
  try {
    assert.equal(pub.onEvent('family', {}), undefined); // synchronous timer arming only
    await pub.whenIdle();
    assert.equal(calls.length, 1);
    await sleep(10); // silence — no self-retry loop
    assert.equal(calls.length, 1, 'no self-retry after a failure');
    pub.onEvent('family', {}); // the next poll IS the retry
    await pub.whenIdle();
    assert.equal(calls.length, 2);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(rejections, [], 'no unhandledRejection may escape the publisher');
  } finally {
    process.removeListener('unhandledRejection', onReject);
  }
  store.close();
});

test('publisher: abort wiring — fetch gets an AbortSignal; stop() aborts mid-flight promptly', async () => {
  const store = seededStore();
  const { fetch, calls } = captureFetch({ hang: true });
  const { pub } = makePublisher({ store, fetch });

  pub.onEvent('family', {});
  await sleep(5);
  assert.equal(calls.length, 1);
  const signal = calls[0].init.signal;
  assert.ok(signal instanceof AbortSignal, 'the 10 s AbortSignal.timeout path is wired');
  assert.equal(signal.aborted, false);
  await pub.stop(); // resolves promptly — never awaits the hung socket
  assert.equal(signal.aborted, true, 'stop() aborts the in-flight fetch');
  store.close();
});

test('publisher: stop() clears an armed debounce timer — no send after shutdown', async () => {
  const store = seededStore();
  const { fetch, calls } = captureFetch();
  const { pub } = makePublisher({ store, fetch, debounceMs: 5 });

  pub.onEvent('family', {});
  await pub.stop(); // before the timer fires
  await sleep(15);
  assert.equal(calls.length, 0);
  store.close();
});

// ---- publisher: log hygiene (PUB-U9, PUB-U10) --------------------------------

test('publisher: token never appears in any log line (success + failure paths)', async () => {
  const store = seededStore();
  const logger = recordingLogger();
  const { fetch } = captureFetch({ failTimes: 1 });
  const { pub } = makePublisher({ store, fetch, logger });

  pub.onEvent('family', {});
  await pub.whenIdle(); // failure → throttled warn line
  pub.onEvent('family', {});
  await pub.whenIdle(); // success → recovery line

  assert.ok(logger.lines.length >= 2);
  for (const line of logger.lines) {
    assert.ok(!line.includes(TOKEN), `token leaked: ${line}`);
    assert.ok(!/authorization/i.test(line), `header leaked: ${line}`);
    assert.ok(!line.includes('/api/push'), 'lines carry the host at most, not the endpoint');
  }
  store.close();
});

test('publisher: failure logs throttled to 1 line per 5 min + exactly one recovery line', async () => {
  const store = seededStore();
  const logger = recordingLogger();
  const { fetch } = captureFetch({ failTimes: 3 });
  const { pub, tick } = makePublisher({ store, fetch, logger });

  pub.onEvent('family', {});
  await pub.whenIdle(); // fail #1 at T+0 → logs immediately
  tick(60_000);
  pub.onEvent('family', {});
  await pub.whenIdle(); // fail #2 at T+1min → suppressed (< 5 min)
  tick(5 * 60_000);
  pub.onEvent('family', {});
  await pub.whenIdle(); // fail #3 at T+6min → logs (≥ 5 min since last line)
  pub.onEvent('family', {});
  await pub.whenIdle(); // success → one recovery line

  const failLines = logger.lines.filter((l) => l.includes('push failed'));
  const recoveredLines = logger.lines.filter((l) => l.includes('push recovered'));
  assert.equal(failLines.length, 2, 'first failure immediate, then ≤ 1 line / 5 min');
  assert.equal(recoveredLines.length, 1);
  assert.equal(pub._state.failedSends, 3);
  assert.equal(pub._state.suppressedFailureLogs, 1);
  assert.equal(pub._state.okSends, 1);
  store.close();
});

// ---- index.js wiring seams (CFG-U5 + boot log lines) --------------------------

test('wireNotifier: no creds → no-op notifier + exactly the "telegram: disabled" line', async () => {
  const store = seededStore();
  const logger = recordingLogger();
  const notifier = wireNotifier({ secrets: null, store, logger });

  assert.equal(notifier.noop, true);
  // Same interface as createTelegramNotifier — callable, resolving, records nothing.
  const edge = await notifier.notifyEdge({ plan: { id: 'x' }, family: {}, deepLink: 'https://x' });
  const blind = await notifier.notifyBlind({ family: {}, reasons: ['persistent-unknown'] });
  assert.equal(edge.ok, true);
  assert.equal(blind.ok, true);
  assert.equal(store.recentTelegram(5).length, 0, 'the no-op records nothing');
  assert.deepEqual(logger.lines, ['[index] telegram: disabled (no credentials)']);
  store.close();
});

test('wireNotifier: creds present → the real notifier factory is used, no disabled line', () => {
  const store = seededStore();
  const logger = recordingLogger();
  const secrets = { botToken: 'TESTBOTTOKEN', chatId: '424242' };
  const seen = [];
  const notifier = wireNotifier({
    secrets,
    store,
    logger,
    createNotifier: (opts) => (seen.push(opts), { real: true }),
  });

  assert.equal(notifier.real, true);
  assert.equal(seen[0].secrets, secrets);
  assert.equal(seen[0].store, store);
  assert.ok(!logger.lines.some((l) => l.includes('telegram: disabled')));
  assert.ok(!logger.lines.some((l) => l.includes('TESTBOTTOKEN')), 'secret values never logged');
  store.close();
});

test('wirePublisher: configured → enabled + origin-only boot line; null → disabled line', () => {
  const store = seededStore();
  const on = recordingLogger();
  const seen = [];
  const enabled = wirePublisher({
    config: CONFIG,
    getWatchlist: () => loadWatchlist(),
    store,
    cadenceSec: 300, // index.js passes the resolved target — the band midpoint (§B6)
    logger: on,
    create: (opts) => (seen.push(opts), createPublisher({ ...opts, fetch: async () => ({ ok: true }) })),
  });
  assert.equal(enabled.enabled, true);
  assert.equal(seen[0].cadenceSec, 300, 'wirePublisher forwards cadenceSec to the factory');
  assert.deepEqual(on.lines, ['[index] push: enabled -> https://vps-stock.example.com']);

  const off = recordingLogger();
  const disabled = wirePublisher({ config: null, getWatchlist: () => loadWatchlist(), store, logger: off });
  assert.equal(disabled.enabled, false);
  assert.deepEqual(off.lines, ['[index] push: disabled (not configured)']);
  store.close();
});
