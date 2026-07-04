// Integration tests for the public board server (board-server/server.js): the
// bearer-gated push guard chain (401/400/413/422/408 → accept), the warming-up
// contract, restart survival off the atomic snapshot mirror, the GET-only route
// manifest audit, static allowlist + traversal, and the no-Telegram guarantee
// (static import graph + runtime zero-egress). Real loopback HTTP against
// ephemeral ports + tmpdir snapshot files; the clock is injected everywhere.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { request } from 'node:http';
import { createBoardServer } from '../board-server/server.js';
import { readFixture } from './helpers.js';

const SERVER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'board-server', 'server.js');
const SENTINEL_TOKEN = 'sentinel-push-token-cafe0000cafe0000cafe0000cafe0000';
const T0 = Date.parse('2026-07-04T05:00:00.000Z');
const FIXTURE_STATE = JSON.parse(readFixture('board-snapshot.json'));

// Recording logger — lets the final test prove the token never reaches a log line.
const logLines = [];
const RECORDER = {
  log: (m) => logLines.push(String(m)),
  warn: (m) => logLines.push(String(m)),
  error: (m) => logLines.push(String(m)),
};
const SILENT = { log() {}, warn() {}, error() {} };

let tmp; // per-run scratch dir (snapshot files + static fixtures)
let clock; // injected server clock
let server;
let base;

/** Minimal static bundle so asset tests don't depend on the frontend slice. */
function makeStaticDir(root) {
  mkdirSync(join(root, 'js'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>VPS Stock Watch</title><div id="freshPill"></div>');
  writeFileSync(join(root, 'board.css'), ':root{--ink:#000}');
  for (const name of ['board.js', 'render.js', 'util.js']) writeFileSync(join(root, 'js', name), `// ${name}\n`);
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'dmit-board-'));
  makeStaticDir(join(tmp, 'public'));
  clock = T0;
  server = createBoardServer({
    port: 0,
    token: SENTINEL_TOKEN,
    snapshotFile: join(tmp, 'snapshot.json'),
    staticDir: join(tmp, 'public'),
    now: () => clock,
    logger: RECORDER,
  });
  const port = await server.start();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await server.stop();
  rmSync(tmp, { recursive: true, force: true });
});

const envelope = (state = FIXTURE_STATE, pushedAt = T0) => JSON.stringify({ v: 1, pushedAt, state });
const push = (body, headers = {}) =>
  fetch(base + '/api/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SENTINEL_TOKEN}`, ...headers },
    body,
  });
const getJson = async (p) => {
  const r = await fetch(base + p);
  assert.ok(r.ok, `${p} → ${r.status}`);
  return r.json();
};
const flat = (s) => s.datacenters.flatMap((dc) => dc.generations.flatMap((g) => g.plans));

/** node:http request that sends the path VERBATIM (fetch normalizes ../ away). */
const rawRequest = (port, { method = 'GET', path = '/', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });

// ---- warming up (missing snapshot file is a designed state) -----------------

test('warming up: /api/state is 200 with null doc fields + no-store, /healthz ok with null age', async () => {
  const res = await fetch(base + '/api/state');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const doc = await res.json();
  assert.deepEqual(doc, { v: null, pushedAt: null, receivedAt: null, now: T0, state: null });

  const hz = await fetch(base + '/healthz');
  assert.equal(hz.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await hz.json(), { ok: true, receivedAt: null, ageMs: null });
});

// ---- push auth matrix --------------------------------------------------------

test('401: missing, malformed, wrong, and wrong-length Authorization all get the uniform body', async () => {
  const attempts = [
    {}, // no header at all
    { authorization: 'Basic abc' }, // not a bearer scheme
    { authorization: `Bearer wrong-${SENTINEL_TOKEN}` }, // wrong value, different length
    { authorization: 'Bearer x' }, // wrong-length: hash-then-compare must not throw
  ];
  for (const headers of attempts) {
    const res = await fetch(base + '/api/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: envelope(),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
  // The always-on process must survive — a follow-up read still succeeds.
  assert.equal((await fetch(base + '/api/state')).status, 200);
});

test('fail-closed: a server booted with NO token 401s every push while reads keep serving', async () => {
  const file = join(tmp, 'fail-closed.json');
  // Pre-seed a valid persisted doc: a misdeployed env file must degrade to
  // staleness (old data keeps serving), never to an open write endpoint.
  writeFileSync(file, JSON.stringify({ v: 1, pushedAt: T0 - 1000, receivedAt: T0 - 500, state: FIXTURE_STATE }));
  const lines = [];
  const noToken = createBoardServer({
    port: 0,
    snapshotFile: file,
    staticDir: join(tmp, 'public'),
    now: () => clock,
    logger: { log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) },
  });
  const port = await noToken.start();
  try {
    assert.ok(lines.some((l) => /PUSH_TOKEN not configured/.test(l)), 'boot warns loudly about the missing token');
    const res = await fetch(`http://127.0.0.1:${port}/api/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SENTINEL_TOKEN}` },
      body: envelope(),
    });
    assert.equal(res.status, 401); // even a plausible bearer is rejected
    const doc = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(doc.receivedAt, T0 - 500); // the file's content still serves
  } finally {
    await noToken.stop();
  }
});

// ---- happy path with the realistic fixture ------------------------------------

test('push → GET visibility: the 37-plan fixture lands, privacy-filtered, well under the body cap', async () => {
  const body = envelope();
  assert.ok(Buffer.byteLength(body) <= 32 * 1024, `envelope is ${Buffer.byteLength(body)} B — must keep ≥2× headroom under 64 KB`);

  const res = await push(body);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, receivedAt: T0 });

  const stateRes = await fetch(base + '/api/state');
  assert.equal(stateRes.headers.get('cache-control'), 'no-store');
  const doc = await stateRes.json();
  assert.equal(doc.v, 1);
  assert.equal(doc.receivedAt, T0);
  assert.equal(doc.now, T0);
  const plans = flat(doc.state);
  assert.equal(plans.length, 37);
  assert.equal(doc.state.counts.total, 37);
  assert.equal(doc.state.datacenters.reduce((n, dc) => n + dc.generations.length, 0), 7);
  // No operator internals on the wire (publisher strips; server passes through).
  assert.ok(!('watcher' in doc.state), 'watcher key must not be on the public wire');
  assert.ok(plans.every((p) => !('lastCheckMs' in p)), 'per-plan lastCheckMs must be stripped');
  assert.ok(plans.every((p) => p.alarm === false), 'alarm:false everywhere');
});

test('bearer is the entire write-auth: a foreign Origin + cross-site push with a valid token is accepted', async () => {
  clock = T0 + 10_000;
  const res = await push(envelope(FIXTURE_STATE, T0 + 9_000), {
    origin: 'https://evil.example.com',
    'sec-fetch-site': 'cross-site',
  });
  assert.equal(res.status, 200); // the panel's CSRF guard is deliberately NOT ported
  assert.equal((await res.json()).receivedAt, T0 + 10_000);
});

// ---- body + shape guards (each followed by a liveness read) --------------------

test('400: malformed JSON push → clean status and the server stays up', async () => {
  const res = await push('{ this is : not json');
  assert.equal(res.status, 400);
  assert.equal((await fetch(base + '/api/state')).status, 200);
});

test('413: an oversized push body → clean status, not a dead socket', async () => {
  const res = await push('x'.repeat(70 * 1024)); // > 64 KB cap
  assert.equal(res.status, 413);
  assert.equal((await fetch(base + '/api/state')).status, 200);
});

test('422: wrong-shape envelopes are rejected and the prior good snapshot keeps serving', async () => {
  const beforeDoc = await getJson('/api/state');
  const bad = [
    { v: 2, pushedAt: T0, state: FIXTURE_STATE }, // wrong schema version
    { v: 1, pushedAt: 'soon', state: FIXTURE_STATE }, // non-numeric pushedAt
    { v: 1, pushedAt: T0, state: { datacenters: {} } }, // datacenters not an array
    { v: 1, pushedAt: T0 }, // no state at all
  ];
  for (const b of bad) {
    const res = await push(JSON.stringify(b));
    assert.equal(res.status, 422, `expected 422 for ${JSON.stringify(b).slice(0, 40)}`);
    assert.equal((await fetch(base + '/healthz')).status, 200); // still answering
  }
  const afterDoc = await getJson('/api/state');
  assert.equal(afterDoc.receivedAt, beforeDoc.receivedAt); // in-memory doc unchanged
});

test('408: a stalled push body times out cleanly (raw socket, short bodyTimeoutMs)', async () => {
  const slow = createBoardServer({
    port: 0,
    token: SENTINEL_TOKEN,
    snapshotFile: join(tmp, 'slow.json'),
    staticDir: join(tmp, 'public'),
    logger: SILENT,
    bodyTimeoutMs: 150,
  });
  const port = await slow.start();
  try {
    const status = await new Promise((resolve, reject) => {
      const sock = createConnection(port, '127.0.0.1', () => {
        // Declare a body via Content-Length but never send it.
        sock.write(
          'POST /api/push HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            `Authorization: Bearer ${SENTINEL_TOKEN}\r\n` +
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

// ---- freshness plumbing --------------------------------------------------------

test('/healthz reports honest age from receivedAt against the injected clock', async () => {
  clock = T0 + 10_000 + 90_000; // 90 s after the last accepted push
  const hz = await getJson('/healthz');
  assert.deepEqual(hz, { ok: true, receivedAt: T0 + 10_000, ageMs: 90_000 });
});

// ---- snapshot file: restart survival + corrupt/missing boots --------------------

test('restart survival: a new instance on the same file serves the persisted doc with honest receivedAt', async () => {
  const file = join(tmp, 'restart.json');
  const a = createBoardServer({ port: 0, token: SENTINEL_TOKEN, snapshotFile: file, staticDir: join(tmp, 'public'), now: () => T0, logger: SILENT });
  const portA = await a.start();
  const res = await fetch(`http://127.0.0.1:${portA}/api/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SENTINEL_TOKEN}` },
    body: envelope(),
  });
  assert.equal(res.status, 200);
  await a.stop();
  // The mirror is the atomic rename target — no .tmp litter after an accepted push.
  assert.ok(existsSync(file), 'snapshot.json persisted');
  assert.ok(!existsSync(`${file}.tmp`), 'no .tmp file left behind');

  const b = createBoardServer({ port: 0, token: SENTINEL_TOKEN, snapshotFile: file, staticDir: join(tmp, 'public'), now: () => T0 + 30 * 60_000, logger: SILENT });
  const portB = await b.start();
  try {
    const doc = await (await fetch(`http://127.0.0.1:${portB}/api/state`)).json();
    assert.equal(doc.receivedAt, T0); // persisted, not re-stamped — never fake freshness
    assert.equal(flat(doc.state).length, 37);
    const hz = await (await fetch(`http://127.0.0.1:${portB}/healthz`)).json();
    assert.equal(hz.ageMs, 30 * 60_000);
  } finally {
    await b.stop();
  }
});

test('corrupt snapshot file: renamed aside to .corrupt, clean empty boot, one warning', async () => {
  const variants = [
    ['garbage bytes', '\x00\x01 not even json'],
    ['truncated JSON', '{"v":1,"receivedAt":175'],
    ['valid JSON, wrong shape', JSON.stringify({ hello: 'world' })],
  ];
  for (const [label, content] of variants) {
    const file = join(tmp, `corrupt-${variants.findIndex(([l]) => l === label)}.json`);
    writeFileSync(file, content);
    const lines = [];
    const s = createBoardServer({
      port: 0,
      token: SENTINEL_TOKEN,
      snapshotFile: file,
      staticDir: join(tmp, 'public'),
      now: () => T0,
      logger: { log() {}, warn: (m) => lines.push(m), error() {} },
    });
    const port = await s.start();
    try {
      const doc = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
      assert.equal(doc.state, null, `${label}: boots to warming up`);
      assert.ok(!existsSync(file), `${label}: bad file moved out of the way`);
      assert.ok(existsSync(`${file}.corrupt`), `${label}: renamed aside to .corrupt`);
      assert.equal(lines.filter((l) => /snapshot file unreadable/.test(l)).length, 1, `${label}: warns exactly once`);
    } finally {
      await s.stop();
    }
  }
});

// ---- GET-only public surface: route-manifest audit ------------------------------

test('route manifest: every non-push path 405s mutating methods; panel-only paths are 404', async () => {
  const manifest = ['/', '/board.css', '/js/board.js', '/js/render.js', '/js/util.js', '/api/state', '/healthz'];
  for (const path of manifest) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(base + path, { method });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get('allow'), 'GET', `${method} ${path} Allow header`);
    }
  }
  // The push route inverts the gate.
  const getPush = await fetch(base + '/api/push');
  assert.equal(getPush.status, 405);
  assert.equal(getPush.headers.get('allow'), 'POST');
  // The panel's mutating endpoints simply do not exist here (405 first as POST).
  for (const path of ['/api/silence', '/api/watchlist/remove']) {
    assert.equal((await fetch(base + path)).status, 404, `GET ${path}`);
    assert.equal((await fetch(base + path, { method: 'POST' })).status, 405, `POST ${path}`);
  }
});

// ---- static allowlist ------------------------------------------------------------

test('static: allowlisted assets serve with correct types + cache headers; everything else 404s', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.match(await page.text(), /freshPill/);

  const css = await fetch(base + '/board.css');
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.equal(css.headers.get('cache-control'), 'public, max-age=300');
  const js = await fetch(base + '/js/board.js');
  assert.match(js.headers.get('content-type'), /javascript/);

  assert.equal((await fetch(base + '/js/nope.js')).status, 404); // outside the allowlist
  assert.equal((await fetch(base + '/snapshot.json')).status, 404);
  // Security headers ride on every response.
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(css.headers.get('x-frame-options'), 'DENY');
});

test('static: directory traversal is rejected, even sent verbatim past fetch normalization', async () => {
  const port = Number(new URL(base).port);
  for (const path of ['/../src/config.js', '/../../etc/passwd', '/%2e%2e/src/config.js', '/js/../../server.js']) {
    const { status } = await rawRequest(port, { path });
    assert.equal(status, 404, `GET ${path}`);
  }
});

test('static: absent staticDir degrades to a 503 placeholder page, not a crash', async () => {
  const bare = createBoardServer({
    port: 0,
    token: SENTINEL_TOKEN,
    snapshotFile: join(tmp, 'bare.json'),
    staticDir: join(tmp, 'no-such-dir'),
    logger: SILENT,
  });
  const port = await bare.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 503);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /not deployed/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/board.css`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 200); // API unaffected
  } finally {
    await bare.stop();
  }
});

test('HEAD is served as GET without a body', async () => {
  const res = await fetch(base + '/api/state', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(await res.text(), '');
});

// ---- the no-Telegram guarantee, both ways ----------------------------------------

test('no-Telegram (static): server.js imports only node: builtins and never mentions telegram', () => {
  const src = readFileSync(SERVER_SOURCE, 'utf8');
  const specifiers = [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.ok(specifiers.length > 0, 'found the import block');
  for (const spec of specifiers) {
    assert.ok(spec.startsWith('node:'), `import '${spec}' must be a node: builtin (never ../src/)`);
  }
  assert.ok(!/telegram/i.test(src), 'the string "telegram" must not appear in board-server/server.js');
  assert.ok(!src.includes('api.telegram.org'), 'no Telegram API host anywhere');
});

test('no-Telegram (runtime): a full push + read cycle makes zero outbound fetch calls', async () => {
  const recorded = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    recorded.push(args[0]);
    return Promise.reject(new Error('outbound network disabled in test'));
  };
  try {
    const port = Number(new URL(base).port);
    // Drive the cycle over node:http so the stubbed global fetch stays untouched
    // by the test client itself — any recorded call would be the server's.
    const pushRes = await rawRequest(port, {
      method: 'POST',
      path: '/api/push',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SENTINEL_TOKEN}` },
      body: envelope(FIXTURE_STATE, T0 + 60_000),
    });
    assert.equal(pushRes.status, 200);
    assert.equal((await rawRequest(port, { path: '/api/state' })).status, 200);
    assert.equal((await rawRequest(port, { path: '/healthz' })).status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(recorded, [], 'the board server must never make an outbound request');
});

// ---- log hygiene ------------------------------------------------------------------

test('the push token never appears in any log line or response body', async () => {
  const stateBody = JSON.stringify(await getJson('/api/state'));
  assert.ok(!stateBody.includes(SENTINEL_TOKEN), 'token must not leak into /api/state');
  assert.ok(logLines.length > 0, 'the recording logger saw operational lines');
  for (const line of logLines) {
    assert.ok(!line.includes(SENTINEL_TOKEN), `token leaked into a log line: ${line}`);
  }
});
