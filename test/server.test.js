// Integration tests for the localhost panel server (src/server.js): the REST
// surface, the SSE bridge (broadcast → alert/plan/snapshot), Silence, and the
// persisted watchlist/remove. Runs against an in-memory store + a TEMP copy of
// the watchlist so the real config/watchlist.json is never touched.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createPanelServer } from '../src/server.js';
import { openStore } from '../src/store.js';
import { loadWatchlist } from '../src/config.js';
import { WATCHLIST_FILE } from '../src/paths.js';

const SILENT = { log() {}, warn() {}, error() {} };
let store;
let server;
let base;
let tmpWatchlist;

before(async () => {
  tmpWatchlist = join(tmpdir(), `dmit-watchlist-${process.pid}-${Date.now()}.json`);
  copyFileSync(WATCHLIST_FILE, tmpWatchlist);
  store = openStore(':memory:');
  store.seedFromWatchlist(loadWatchlist(tmpWatchlist));
  store.touchHeartbeat({ chromeSession: 'UP' });
  server = createPanelServer({
    store,
    watchlist: loadWatchlist(tmpWatchlist),
    watchlistPath: tmpWatchlist,
    port: 0,
    logger: SILENT,
  });
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.stop();
  store.close();
  rmSync(tmpWatchlist, { force: true });
});

const getJson = async (p) => {
  const r = await fetch(base + p);
  assert.ok(r.ok, `${p} → ${r.status}`);
  return r.json();
};
const flat = (s) => s.datacenters.flatMap((dc) => dc.generations.flatMap((g) => g.plans));

/** Open /events, invoke onEvent per frame, return a closer. */
function openEventStream(onEvent) {
  const ac = new AbortController();
  const done = fetch(base + '/events', { signal: ac.signal }).then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = {};
          for (const ln of frame.split('\n')) {
            if (ln.startsWith('event:')) ev.event = ln.slice(6).trim();
            else if (ln.startsWith('data:')) ev.data = ln.slice(5).trim();
          }
          if (ev.event) onEvent(ev);
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    }
  });
  return { close: () => ac.abort(), done };
}

const deadline = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms).unref?.());

test('GET /api/state returns 33 plans, counts, and fixed datacenter order', async () => {
  const s = await getJson('/api/state');
  assert.equal(flat(s).length, 33);
  assert.equal(s.counts.total, 33);
  assert.deepEqual(s.counts.byLoc, { lax: 16, hkg: 10, tyo: 7 });
  assert.deepEqual(s.datacenters.map((dc) => dc.loc), ['lax', 'hkg', 'tyo']);
});

test('GET /api/health returns 6 families + telegram array', async () => {
  const h = await getJson('/api/health');
  assert.equal(h.families.length, 6);
  assert.ok(Array.isArray(h.telegram));
});

test('GET / serves the panel HTML and module/css assets with correct types', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /<title>DMIT Restock Watch/);
  assert.match(html, /\/js\/app\.js/);
  const js = await fetch(base + '/js/app.js');
  assert.ok(js.ok);
  assert.match(js.headers.get('content-type') || '', /javascript/);
  const css = await fetch(base + '/css/tokens.css');
  assert.match(css.headers.get('content-type') || '', /css/);
});

test('path traversal outside public/ is blocked', async () => {
  const r = await fetch(base + '/../src/server.js');
  assert.ok(r.status === 404 || r.status === 403);
});

test('SSE: connect replays a snapshot, and broadcast(edge) pushes alert + plan', async () => {
  store.setPlanState('lax-an4-medium', { status: 'IN', lastKnown: 'IN', lastChange: Date.now() });
  const events = [];
  let resolveAlert;
  const gotAlert = new Promise((r) => (resolveAlert = r));
  const stream = openEventStream((ev) => {
    events.push(ev.event);
    if (ev.event === 'alert') resolveAlert(JSON.parse(ev.data));
  });

  // wait for the on-connect snapshot
  await Promise.race([
    (async () => {
      while (!events.includes('snapshot')) await new Promise((r) => setTimeout(r, 10));
    })(),
    deadline(2000),
  ]);

  const wl = server.watchlist;
  const plan = wl.plans.find((p) => p.id === 'lax-an4-medium');
  const family = wl.families.find((f) => f.key === plan.family);
  server.broadcast('edge', { plan, family, deepLink: plan.deepLink });

  const alert = await Promise.race([gotAlert, deadline(2000)]);
  assert.equal(alert.id, 'lax-an4-medium');
  assert.match(alert.deepLink, /cart\.php/);
  assert.ok(events.includes('plan'));
  stream.close();
});

test('POST /api/silence clears the alarm flag but keeps the plan in stock', async () => {
  store.setPlanState('hkg-an5-mini', { status: 'IN', lastKnown: 'IN', lastChange: Date.now() });
  const wl = server.watchlist;
  const plan = wl.plans.find((p) => p.id === 'hkg-an5-mini');
  server.broadcast('edge', { plan, family: wl.families.find((f) => f.key === plan.family), deepLink: plan.deepLink });

  let s = await getJson('/api/state');
  let p = flat(s).find((x) => x.id === 'hkg-an5-mini');
  assert.equal(p.alarm, true);

  const res = await fetch(base + '/api/silence', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'hkg-an5-mini' }),
  });
  assert.ok(res.ok);

  s = await getJson('/api/state');
  p = flat(s).find((x) => x.id === 'hkg-an5-mini');
  assert.equal(p.alarm, false);
  assert.equal(p.status, 'in'); // silenced, not removed
});

test('POST /api/silence rejects a missing id', async () => {
  const res = await fetch(base + '/api/silence', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('POST /api/watchlist/remove drops a family and persists', async () => {
  const before = flat(await getJson('/api/state')).length;
  const res = await fetch(base + '/api/watchlist/remove', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ family: 'tyo/as3' }),
  });
  assert.ok(res.ok);
  const body = await res.json();
  assert.ok(!body.families.includes('tyo/as3'));

  const s = await getJson('/api/state');
  assert.equal(flat(s).length, before - 7); // TYO·AS3 has 7 plans
  assert.ok(!s.datacenters.some((dc) => dc.loc === 'tyo'));

  // persisted to the temp file
  const reloaded = loadWatchlist(tmpWatchlist);
  assert.ok(!reloaded.families.some((f) => f.key === 'tyo/as3'));
});

test('POST /api/watchlist/remove rejects an unknown family', async () => {
  const res = await fetch(base + '/api/watchlist/remove', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ family: 'nope/xx' }),
  });
  assert.equal(res.status, 400);
});

// ---- CSRF guard on state-changing POSTs -----------------------------------

test('CSRF: a cross-origin Origin POST is rejected with 403', async () => {
  const res = await fetch(base + '/api/silence', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
    body: JSON.stringify({ id: 'lax-an4-medium' }),
  });
  assert.equal(res.status, 403);
});

test('CSRF: a Sec-Fetch-Site:cross-site POST is rejected with 403', async () => {
  const res = await fetch(base + '/api/silence', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ id: 'lax-an4-medium' }),
  });
  assert.equal(res.status, 403);
});

test('CSRF: a text/plain ("simple request") POST is rejected with 403', async () => {
  const res = await fetch(base + '/api/silence', {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ id: 'lax-an4-medium' }),
  });
  assert.equal(res.status, 403);
});

test('CSRF: a same-origin application/json POST is accepted', async () => {
  const res = await fetch(base + '/api/silence', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: base, // http://127.0.0.1:<port> — equals our Host
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify({ id: 'lax-an4-medium' }),
  });
  assert.ok(res.ok, `expected 2xx, got ${res.status}`);
  const body = await res.json();
  assert.equal(body.ok, true);
});

// ---- H1: hardened POST body handling (no-crash 400/413/500) ----------------

const postJson = (path, body, headers) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

test('H1: malformed JSON POST → 400 and the server stays up', async () => {
  const res = await postJson('/api/silence', '{ this is : not json');
  assert.equal(res.status, 400);
  // The always-on process must survive — a follow-up request still succeeds.
  const after = await fetch(base + '/api/state');
  assert.ok(after.ok, `server should still serve after a malformed body (got ${after.status})`);
});

test('H1: an oversized POST body → 413 (not a dead socket)', async () => {
  const huge = JSON.stringify({ id: 'x'.repeat(70 * 1024) }); // > 64 KB cap
  const res = await postJson('/api/silence', huge);
  assert.equal(res.status, 413);
  const after = await fetch(base + '/api/state'); // still alive
  assert.ok(after.ok);
});

test('L3: POST /api/silence for an unknown plan id → 404 (not a fake ok:true)', async () => {
  const res = await postJson('/api/silence', JSON.stringify({ id: 'no-such-plan' }));
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test('H1: a handler that throws → 500, no unhandledRejection escapes', async () => {
  const rejections = [];
  const onReject = (r) => rejections.push(r);
  process.on('unhandledRejection', onReject);

  // A store whose getPlan() blows up: handleSilence reaches pushPlan → planDeltaFor
  // → store.getPlan(), which throws an *unexpected* error. The router must turn it
  // into a 500 and never let the rejection escape the server callback.
  const boomStore = {
    getPlan() {
      throw new Error('boom');
    },
  };
  const wl = {
    settings: {},
    families: [{ key: 'x/y', loc: 'x', gen: 'y' }],
    plans: [{ id: 'p1', family: 'x/y', name: 'P1' }],
  };
  const boom = createPanelServer({ store: boomStore, watchlist: wl, port: 0, logger: SILENT });
  await boom.start();
  const boomBase = `http://127.0.0.1:${boom.port}`;
  try {
    const res = await fetch(boomBase + '/api/silence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'p1' }),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'internal error'); // no internal detail leaked
    // Still serving after the throw.
    const after = await fetch(boomBase + '/api/health');
    assert.ok(after.status === 200 || after.status === 500);
  } finally {
    await new Promise((r) => setTimeout(r, 20)); // let any stray microtask settle
    process.removeListener('unhandledRejection', onReject);
    await boom.stop();
  }
  assert.deepEqual(rejections, [], 'no unhandledRejection should escape the server callback');
});

test('H1: a stalled POST body → 408 within the read timeout (raw socket)', async () => {
  // A short body timeout so the test is fast; assert the server replies 408 and
  // closes instead of hanging forever on a client that sends headers but no body.
  const slow = createPanelServer({ store, watchlist: loadWatchlist(tmpWatchlist), port: 0, logger: SILENT, bodyTimeoutMs: 150 });
  await slow.start();
  try {
    const status = await new Promise((resolve, reject) => {
      const sock = createConnection(slow.port, '127.0.0.1', () => {
        // Declare a body via Content-Length but never send it.
        sock.write(
          'POST /api/silence HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            'Content-Type: application/json\r\n' +
            'Content-Length: 99\r\n\r\n',
        );
      });
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (d) => {
        buf += d;
        const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
        if (m) {
          resolve(Number(m[1]));
          sock.destroy();
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('no response within 3s')), 3000).unref?.();
    });
    assert.equal(status, 408);
  } finally {
    await slow.stop();
  }
});
