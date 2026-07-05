// Integration tests for the public board server (board-server/): the
// bearer-gated push guard chain (401/400/413/422/408 → accept), the warming-up
// contract, restart survival off the atomic snapshot mirror, the route
// manifest audit, static allowlist + traversal — plus the round-2 subscription
// surface (TECH §Q1.7 VAL-*, §Q3.1 SUB-I*, §Q3.2 AUD-R*): the five POST
// routes over real loopback HTTP with a scriptable fake Telegram behind the
// injected telegramFetch seam, and the SIX round-1 invariants REWRITTEN IN
// PLACE as allowlists (never deleted — D8; the tripwire test at the bottom
// keeps the repeal honest). Ephemeral ports + tmpdir files; injected clocks.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createBoardServer } from '../board-server/server.js';
import { lookupHash } from '../board-server/sub-store.js';
import { readFixture } from './helpers.js';

const SERVER_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'board-server', 'server.js');
const SENTINEL_TOKEN = 'sentinel-push-token-cafe0000cafe0000cafe0000cafe0000';
const TOKEN_KEY = '55'.repeat(32); // built at runtime — never a hex-literal of key length (SEC-6)
const SUB_TOKEN = '8000000001:TESTSENTINELTOKENxxxxxxxxxxxxxxxx'; // §Q0 sentinel convention
const SUB_CHAT_ID = '4400000042';
const T0 = Date.parse('2026-07-04T05:00:00.000Z');
const FIXTURE_STATE = JSON.parse(readFixture('board-snapshot.json'));
// Distinct sentinel bot tokens (all shape-valid, all TESTSENTINEL-embedded) so
// per-token rate buckets never bleed between tests on a shared server.
const stok = (n) => `800000${String(n).padStart(4, '0')}:TESTSENTINELTOKEN${'x'.repeat(16)}`;

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
  // AUD-R4 rewrite: the shape gains cadenceSec:null — kept a STRICT deepEqual
  // so the next envelope field is again a conscious test edit, never an accident.
  assert.deepEqual(doc, { v: null, pushedAt: null, receivedAt: null, now: T0, cadenceSec: null, state: null });

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

// ---- route-manifest audit (AUD-R3 rewrite of the round-1 GET-only invariant) -----
// The mutating allowlist is now /api/push + the five subscription POSTs,
// exactly; every other path still 405s all mutating methods. This literal
// manifest remains the Gate-3 audit record.

const MUTATING_ALLOWLIST = [
  '/api/push',
  '/api/subscribe',
  '/api/chatid',
  '/api/subscription/lookup',
  '/api/subscription/update',
  '/api/subscription/delete',
];

test('route manifest: the mutating allowlist is push + the five subscription POSTs; everything else 405s mutations', async () => {
  const manifest = ['/', '/board.css', '/js/board.js', '/js/render.js', '/js/util.js', '/js/subscribe.js', '/api/state', '/healthz'];
  for (const path of manifest) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(base + path, { method });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get('allow'), 'GET', `${method} ${path} Allow header`);
    }
  }
  // Each mutating route gets its own 405 inversion: GET → 405, Allow: POST —
  // and PUT/DELETE/PATCH are 405 Allow: POST too (POST is the only verb).
  for (const path of MUTATING_ALLOWLIST) {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(base + path, { method });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get('allow'), 'POST', `${method} ${path} Allow header`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${method} ${path} security headers`);
    }
  }
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

// ---- the egress guarantee, rewritten as allowlists (AUD-R1/AUD-R2 — never deleted)

test('no-Telegram (static): every board-server module imports only node: builtins or local siblings; the external host allowlist is api.telegram.org alone', () => {
  const dir = dirname(SERVER_SOURCE);
  const files = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(files, ['edge-detect.js', 'notifier.js', 'rate-limit.js', 'server.js', 'sub-store.js'], 'the §B0 module map, exactly');
  for (const file of files) {
    const src = readFileSync(join(dir, file), 'utf8');
    const specifiers = [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    for (const spec of specifiers) {
      assert.ok(
        spec.startsWith('node:') || (spec.startsWith('./') && !spec.includes('..')),
        `${file}: import '${spec}' must be a node: builtin or a board-server sibling (never ../src)`,
      );
    }
    // The round-1 "telegram" string ban is lifted DELIBERATELY — this host
    // allowlist replaces it: the only external host string in the directory
    // is api.telegram.org (D8 egress allowlist).
    const hosts = [...src.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]).filter((h) => h.includes('.'));
    for (const host of hosts) {
      assert.equal(host, 'api.telegram.org', `${file}: unexpected external host string "${host}"`);
    }
  }
});

test('no-Telegram (runtime) egress ①: push + read cycles with no subscribers and no edges make zero outbound calls', async () => {
  const recorded = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    recorded.push(String(args[0]));
    return Promise.reject(new Error('outbound network disabled in test'));
  };
  // Factory WITHOUT the telegramFetch seam — the default rides globalThis.fetch,
  // so anything the server sent would land in the recorder.
  const dir = mkdtempSync(join(tmpdir(), 'dmit-egress1-'));
  const s = createBoardServer({
    port: 0,
    token: SENTINEL_TOKEN,
    snapshotFile: join(dir, 'snapshot.json'),
    subDbFile: join(dir, 'board.db'),
    tokenKey: TOKEN_KEY,
    windowMs: 15,
    staticDir: join(tmp, 'public'),
    now: () => clock,
    logger: SILENT,
  });
  try {
    const port = await s.start();
    // Drive everything over node:http so the stubbed global fetch stays
    // untouched by the test client itself — any recorded call is the server's.
    const pushRes = await rawRequest(port, {
      method: 'POST',
      path: '/api/push',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SENTINEL_TOKEN}` },
      body: envelope(FIXTURE_STATE, T0 + 60_000),
    });
    assert.equal(pushRes.status, 200); // seeds fire-free — 27 armed rows, zero sends
    assert.equal((await rawRequest(port, { path: '/api/state' })).status, 200);
    assert.equal((await rawRequest(port, { path: '/healthz' })).status, 200);
    await s.whenSubsIdle();
  } finally {
    await s.stop();
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(recorded, [], 'zero subscribers + zero edges → zero outbound requests');
});

test('no-Telegram (runtime) egress ②: across full push + subscribe + digest cycles every fetch host is api.telegram.org, and only on sends — never on reads', async () => {
  const recorded = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    recorded.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
      text: async () => JSON.stringify({ ok: true, result: {} }),
    };
  };
  const dir = mkdtempSync(join(tmpdir(), 'dmit-egress2-'));
  // Again WITHOUT the telegramFetch seam: the REAL egress paths run against
  // the stubbed global — proof nothing bypasses the seam in production wiring.
  const s = createBoardServer({
    port: 0,
    token: SENTINEL_TOKEN,
    snapshotFile: join(dir, 'snapshot.json'),
    subDbFile: join(dir, 'board.db'),
    tokenKey: TOKEN_KEY,
    windowMs: 15,
    telegramTimeoutMs: 100,
    sleep: async () => {},
    staticDir: join(tmp, 'public'),
    now: () => clock,
    logger: SILENT,
  });
  try {
    const port = await s.start();
    const pushRaw = (state) =>
      rawRequest(port, {
        method: 'POST',
        path: '/api/push',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SENTINEL_TOKEN}` },
        body: JSON.stringify({ v: 1, pushedAt: T0, state }),
      });
    assert.equal((await pushRaw(FIXTURE_STATE)).status, 200); // cold-start seed
    assert.equal(recorded.length, 0, 'seeding sends nothing');
    const subRes = await rawRequest(port, {
      method: 'POST',
      path: '/api/subscribe',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] }),
    });
    assert.equal(subRes.status, 200);
    assert.equal(recorded.length, 1, 'exactly the confirmation send');
    const flipped = structuredClone(FIXTURE_STATE);
    for (const dc of flipped.datacenters) for (const g of dc.generations) for (const p of g.plans) if (p.id === 'lax-as3-tiny') p.status = 'in';
    assert.equal((await pushRaw(flipped)).status, 200);
    await new Promise((r) => setTimeout(r, 40)); // let the 15 ms window close
    await s.whenSubsIdle();
    const afterDigest = recorded.length;
    assert.equal(afterDigest, 2, 'plus exactly the digest send');
    // Reads never egress.
    assert.equal((await rawRequest(port, { path: '/api/state' })).status, 200);
    assert.equal((await rawRequest(port, { path: '/healthz' })).status, 200);
    assert.equal((await rawRequest(port, { path: '/' })).status, 200);
    assert.equal(recorded.length, afterDigest, 'GETs made zero outbound calls');
    for (const url of recorded) {
      assert.equal(new URL(url).host, 'api.telegram.org', `egress allowlist violated: ${url}`);
    }
  } finally {
    await s.stop();
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- log/response hygiene (AUD-R5 rewrite: sentinel set extended) -----------------

test('log/response hygiene: push token + subscriber bot token + chat id never appear in any log line, body, page HTML, or last_error', async () => {
  // Round-1 half: the shared server's push token, unchanged.
  const stateBody = JSON.stringify(await getJson('/api/state'));
  assert.ok(!stateBody.includes(SENTINEL_TOKEN), 'push token must not leak into /api/state');
  assert.ok(logLines.length > 0, 'the recording logger saw operational lines');
  for (const line of logLines) {
    assert.ok(!line.includes(SENTINEL_TOKEN), `push token leaked into a log line: ${line}`);
  }

  // Round-2 half: run success AND failure subscription paths on a dedicated
  // harness, then sweep every log line, every GET body, every error body
  // (including failed-confirmation 422s and 502s), the page HTML, and every
  // digest_queue.last_error for the subscriber sentinels.
  const h = await makeSubServer();
  const errorBodies = [];
  try {
    await h.push(FIXTURE_STATE); // seed
    // Success paths: subscribe → digest → lookup → update → chatid.
    assert.equal((await h.post('/api/subscribe', { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] })).status, 200);
    await h.push(h.flip(FIXTURE_STATE, { 'lax-as3-tiny': 'in' }));
    await h.settle();
    assert.equal((await h.post('/api/subscription/lookup', { token: SUB_TOKEN, chatId: SUB_CHAT_ID })).status, 200);
    assert.equal((await h.post('/api/chatid', { token: SUB_TOKEN }, { ip: '10.9.9.1' })).status, 200);
    // Failure paths: rejected confirmation (422), unreachable Telegram (502),
    // uniform 404, and an exhausted digest dispatch (last_error set).
    h.tg.setScript(() => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }));
    errorBodies.push(await (await h.post('/api/subscribe', { token: stok(9101), chatId: '4400000001', planIds: ['lax-as3-tiny'] }, { ip: '10.9.9.2' })).text());
    h.tg.setScript(() => 'hang');
    errorBodies.push(await (await h.post('/api/subscribe', { token: stok(9102), chatId: '4400000002', planIds: ['lax-as3-tiny'] }, { ip: '10.9.9.3' })).text());
    h.tg.setScript(null);
    errorBodies.push(await (await h.post('/api/subscription/lookup', { token: stok(9103), chatId: '4400000003' }, { ip: '10.9.9.4' })).text());
    h.tg.setScript(() => ({ status: 500, body: { ok: false, description: 'Internal' } }));
    await h.push(h.flip(FIXTURE_STATE, { 'lax-as3-tiny': 'out' }));
    await h.push(h.flip(FIXTURE_STATE, { 'lax-as3-tiny': 'in' }));
    await h.settle(); // digest exhausted → last_error populated
    h.tg.setScript(null);

    const page = await (await fetch(h.base + '/')).text();
    const state = await (await fetch(h.base + '/api/state')).text();
    const db = new DatabaseSync(h.dbFile, { readOnly: true });
    const lastErrors = db.prepare('SELECT last_error FROM digest_queue').all().map((r) => String(r.last_error));
    db.close();
    const sweep = [...h.logs, ...errorBodies, ...lastErrors, page, state];
    for (const sentinel of [SENTINEL_TOKEN, SUB_TOKEN, 'TESTSENTINEL', SUB_CHAT_ID]) {
      for (const item of sweep) {
        assert.ok(!item.includes(sentinel), `sentinel "${sentinel.slice(0, 16)}…" leaked: ${item.slice(0, 120)}`);
      }
    }
    for (const item of sweep) {
      assert.ok(!/api\.telegram\.org\/bot/.test(item), `tokened Telegram URL leaked: ${item.slice(0, 120)}`);
    }
    // The 0600-class permission assertion on board.db (RO-I3, repeated here at
    // the integration layer per §B7).
    assert.equal(statSync(h.dbFile).mode & 0o077, 0, 'board.db is 0600-class');
  } finally {
    await h.close();
  }
});

// ═══════════ Round 2 — subscription surface (TECH §Q1.7 VAL, §Q3.1 SUB-I) ═══════════
//
// One real board-server per test group via the factory's §Q0 seams
// ({subDbFile, tokenKey, telegramFetch, now, sleep, windowMs}), exercised over
// real loopback HTTP. fakeTG is a scriptable recorder: default ok for
// sendMessage and a canned single-chat getUpdates; per-test scripts answer
// 401 / 403 / 400 "chat not found" / 409 / 500 / hang.

function makeFakeTG() {
  const calls = [];
  let script = null;
  const fetchImpl = (url, init = {}) => {
    const call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const spec = script ? script(call) : null;
    if (spec === 'hang') return new Promise(() => {});
    let { status = 200, body = null, raw = null } = spec ?? {};
    if (body == null && raw == null) {
      raw = call.url.includes('/getUpdates')
        ? '{"ok":true,"result":[{"update_id":1,"message":{"chat":{"id":5500000077},"text":"hi"}}]}'
        : JSON.stringify({ ok: true, result: {} });
    }
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => (raw != null ? JSON.parse(raw) : body),
      text: async () => (raw != null ? raw : JSON.stringify(body)),
    });
  };
  return { calls, fetch: fetchImpl, setScript: (fn) => (script = fn) };
}

let xffCounter = 0;
async function makeSubServer(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dmit-sub-'));
  const tg = makeFakeTG();
  const logs = [];
  const clockBox = { t: T0 };
  const server = createBoardServer({
    port: 0,
    token: SENTINEL_TOKEN,
    snapshotFile: join(dir, 'snapshot.json'),
    staticDir: join(tmp, 'public'),
    subDbFile: join(dir, 'board.db'),
    tokenKey: TOKEN_KEY,
    telegramFetch: tg.fetch,
    windowMs: 15,
    telegramTimeoutMs: 100,
    sleep: async () => {},
    now: () => clockBox.t,
    logger: { log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    ...overrides,
  });
  const port = await server.start();
  const base = `http://127.0.0.1:${port}`;
  return {
    server,
    tg,
    base,
    dir,
    logs,
    clock: clockBox,
    dbFile: join(dir, 'board.db'),
    push: (state, extra = {}) =>
      fetch(base + '/api/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SENTINEL_TOKEN}` },
        body: JSON.stringify({ v: 1, pushedAt: clockBox.t, state, ...extra }),
      }),
    // Every POST gets a unique first-XFF-hop by default so per-IP buckets never
    // bleed between tests; pass {ip} to key deliberately (SUB-I9/I10).
    post: (path, body, { ip } = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': ip ?? `10.77.${Math.floor(xffCounter / 250)}.${(xffCounter++ % 250) + 1}`,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    flip: (state, statusById) => {
      const clone = structuredClone(state);
      for (const dc of clone.datacenters)
        for (const g of dc.generations)
          for (const p of g.plans) if (statusById[p.id] !== undefined) p.status = statusById[p.id];
      return clone;
    },
    settle: async () => {
      await new Promise((r) => setTimeout(r, 40)); // let the 15 ms window close
      await server.whenSubsIdle();
    },
    db: () => new DatabaseSync(join(dir, 'board.db')), // second WAL connection for assertions/seeding
    close: async () => {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---- VAL: the validation matrix (guard order — cheap checks precede egress) ------

test('VAL-1…VAL-6: shape guards 400/413 with zero Telegram calls and a liveness read after each', async () => {
  const h = await makeSubServer();
  try {
    assert.equal((await h.push(FIXTURE_STATE)).status, 200);
    const reject = async (label, body, status, route = '/api/subscribe') => {
      const before = h.tg.calls.length;
      const res = await h.post(route, body);
      assert.equal(res.status, status, label);
      assert.equal(h.tg.calls.length, before, `${label}: no egress for a failed guard`);
      assert.equal((await fetch(h.base + '/api/state')).status, 200, `${label}: liveness`);
    };
    const ok = { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] };

    await reject('VAL-1 malformed JSON', '{ this is : not json', 400);
    await reject('VAL-1b literal JSON null body', 'null', 400);
    await reject('VAL-2 body > 8 KB (tighter than push’s 64 KB)', JSON.stringify({ ...ok, pad: 'x'.repeat(9 * 1024) }), 413);
    const secret30 = `TESTSENTINELTOKEN${'x'.repeat(13)}`; // exactly 30 chars
    for (const [label, token] of [
      ['7-digit id', `1234567:${secret30}`],
      ['13-digit id', `1234567890123:${secret30}`],
      ['29-char secret', `8000000001:TESTSENTINELTOKEN${'x'.repeat(12)}`],
      ['missing colon', `8000000001${secret30}`],
      ['non-string token', 42],
    ]) {
      await reject(`VAL-3 ${label}`, { ...ok, token }, 400);
    }
    // VAL-3 edge: 12-digit id + 30-char secret PASSES shape (the reconciled
    // relaxed regex) and reaches the Telegram step → 200 with the ok default.
    const edge = await h.post('/api/subscribe', { ...ok, token: `800000000012:${secret30}` });
    assert.equal(edge.status, 200, 'VAL-3 relaxed-regex edge passes');
    // VAL-4: surrounding whitespace is trimmed before testing → reaches Telegram.
    const before = h.tg.calls.length;
    const padded = await h.post('/api/subscribe', { ...ok, token: `  ${SUB_TOKEN}\n` });
    assert.equal(padded.status, 200, 'VAL-4 whitespace-padded token accepted');
    assert.equal(h.tg.calls[before].url, `https://api.telegram.org/bot${SUB_TOKEN}/sendMessage`, 'trimmed before use');

    for (const [label, chatId] of [['letters', '12a'], ['empty', ''], ['JSON number', 123]]) {
      await reject(`VAL-5 chatId ${label}`, { ...ok, chatId }, 400);
    }
    const negative = await h.post('/api/subscribe', { ...ok, token: stok(11), chatId: '-100123456789' });
    assert.equal(negative.status, 200, 'VAL-5 negative group id passes shape');

    for (const [label, planIds] of [['empty array', []], ['non-array', 'lax-as3-tiny'], ['non-string member', [42]]]) {
      await reject(`VAL-6 planIds ${label}`, { ...ok, planIds }, 400);
    }
    const dup = await h.post('/api/subscribe', { ...ok, token: stok(12), planIds: ['lax-as3-tiny', 'lax-as3-tiny'] });
    assert.equal(dup.status, 200);
    assert.deepEqual((await dup.json()).plans, ['lax-as3-tiny'], 'VAL-6 duplicates de-duplicated server-side');
  } finally {
    await h.close();
  }
});

test('VAL-7/VAL-8: unknown planId → 400; the same valid shape on a fresh boot → 503 warming up; update [] → 400', async () => {
  const cold = await makeSubServer();
  try {
    const body = { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] };
    assert.equal((await cold.post('/api/subscribe', body)).status, 503, 'VAL-7 warming up — no snapshot yet');
    assert.equal(cold.tg.calls.length, 0);
    assert.equal((await cold.push(FIXTURE_STATE)).status, 200);
    assert.equal((await cold.post('/api/subscribe', { ...body, planIds: ['no-such-plan'] })).status, 400, 'VAL-7 unknown planId');
    assert.equal((await cold.post('/api/subscription/update', { ...body, planIds: [] })).status, 400, 'VAL-8 update n ≥ 1 enforced');
    assert.equal(cold.tg.calls.length, 0, 'no egress for any of it');
  } finally {
    await cold.close();
  }
});

// ---- SUB-I: the subscription lifecycle over loopback -------------------------------

test('SUB-I1: happy create is D3-mechanical — ONE confirmation send, only then the encrypted row', async () => {
  const h = await makeSubServer();
  try {
    await h.push(FIXTURE_STATE);
    const res = await h.post('/api/subscribe', { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny', 'lax-as3-pocket'] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, plans: ['lax-as3-tiny', 'lax-as3-pocket'], merged: false });
    assert.equal(h.tg.calls.length, 1, 'exactly ONE Telegram call — the confirmation');
    const call = h.tg.calls[0];
    assert.equal(call.url, `https://api.telegram.org/bot${SUB_TOKEN}/sendMessage`);
    assert.equal(call.body.chat_id, SUB_CHAT_ID);
    assert.equal(call.body.parse_mode, 'HTML');
    assert.deepEqual(call.body.link_preview_options, { is_disabled: true });
    assert.ok(call.body.text.startsWith('<b>✅ Subscribed — VPS Stock Watch</b>'), 'the SND-U3 receipt shape');
    assert.ok(call.body.text.includes('• LAX.AS3.Pro.TINY — Los Angeles'));
    assert.ok(call.body.text.includes('• LAX.AS3.Pro.POCKET — Los Angeles'));
    const db = h.db();
    const row = db.prepare('SELECT * FROM subscribers').get();
    db.close();
    assert.equal(row.disabled, 0);
    assert.equal(row.fail_count, 0);
    assert.ok(!Buffer.from(row.token_ct).toString('latin1').includes('TESTSENTINEL'), 'token at rest is ciphertext');
  } finally {
    await h.close();
  }
});

test('SUB-I2: a failed confirmation stores NOTHING — 422 enum reasons, description text never echoed', async () => {
  const h = await makeSubServer();
  try {
    await h.push(FIXTURE_STATE);
    const cases = [
      [() => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }), 'token_rejected'],
      [() => ({ status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } }), 'chat_not_found'],
      [() => ({ status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } }), 'chat_not_found'],
    ];
    for (const [script, reason] of cases) {
      h.tg.setScript(script);
      const res = await h.post('/api/subscribe', { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] });
      assert.equal(res.status, 422);
      assert.deepEqual(await res.json(), { reason }, 'enum reasons ONLY — Telegram description dropped');
      const db = h.db();
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscribers').get().n, 0, `${reason}: zero rows`);
      db.close();
      assert.equal((await fetch(h.base + '/api/state')).status, 200, 'liveness');
    }
  } finally {
    await h.close();
  }
});

test('SUB-I3: Telegram unreachable → 502, nothing stored; a user retry is a fresh, safe create', async () => {
  const h = await makeSubServer({ telegramTimeoutMs: 60 });
  try {
    await h.push(FIXTURE_STATE);
    const body = { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] };
    h.tg.setScript(() => 'hang'); // never settles → the injected timeout aborts
    assert.equal((await h.post('/api/subscribe', body)).status, 502);
    h.tg.setScript(() => ({ status: 500, body: { ok: false, description: 'Internal' } }));
    assert.equal((await h.post('/api/subscribe', body)).status, 502);
    const db = h.db();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscribers').get().n, 0);
    db.close();
    h.tg.setScript(null);
    assert.equal((await h.post('/api/subscribe', body)).status, 200, 'retry is safe — a fresh create');
  } finally {
    await h.close();
  }
});

test('SUB-I4: a duplicate {token, chatId} merges by union — one row, merged:true, the card lists the full set', async () => {
  const h = await makeSubServer();
  try {
    await h.push(FIXTURE_STATE);
    assert.equal((await h.post('/api/subscribe', { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] })).status, 200);
    const res = await h.post('/api/subscribe', { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-pocket', 'lax-as3-tiny'] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, plans: ['lax-as3-tiny', 'lax-as3-pocket'], merged: true }, 'union, merged:true');
    const db = h.db();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscribers').get().n, 1, 'lookup_hash UNIQUE held');
    db.close();
    const secondCard = h.tg.calls[1].body.text;
    assert.ok(secondCard.includes('LAX.AS3.Pro.TINY') && secondCard.includes('LAX.AS3.Pro.POCKET'), 'confirmation lists the merged set');
  } finally {
    await h.close();
  }
});

test('SUB-I5: lookup returns planIds ONLY and never contacts Telegram', async () => {
  const h = await makeSubServer();
  try {
    await h.push(FIXTURE_STATE);
    await h.post('/api/subscribe', { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] });
    const before = h.tg.calls.length;
    const res = await h.post('/api/subscription/lookup', { token: SUB_TOKEN, chatId: SUB_CHAT_ID });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.deepEqual(JSON.parse(raw), { planIds: ['lax-as3-tiny'] }, 'planIds only — no chat metadata, no timestamps');
    assert.ok(!raw.includes('TESTSENTINEL') && !raw.includes(SUB_CHAT_ID), 'sentinel scan finds nothing');
    assert.equal(h.tg.calls.length, before, 'lookup never contacts Telegram (§B3)');
  } finally {
    await h.close();
  }
});

test('SUB-I6: update REPLACES and is receipt-gated; a failed receipt changes nothing; success heals a disabled row', async () => {
  const h = await makeSubServer();
  try {
    await h.push(FIXTURE_STATE);
    await h.post('/api/subscribe', { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] });
    const res = await h.post('/api/subscription/update', { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-pocket'] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, plans: ['lax-as3-pocket'] }, 'replacement, not a union');
    const receipt = h.tg.calls[1];
    assert.ok(receipt.body.text.startsWith('<b>🔄 Subscription updated</b>'), 'the 🔄 receipt sent (before the write)');
    assert.ok(receipt.body.text.includes('LAX.AS3.Pro.POCKET') && !receipt.body.text.includes('LAX.AS3.Pro.TINY'), 'receipt carries the NEW list');

    h.tg.setScript(() => ({ status: 401, body: { ok: false, description: 'Unauthorized' } }));
    const failed = await h.post('/api/subscription/update', { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] });
    assert.equal(failed.status, 422);
    assert.deepEqual(await failed.json(), { reason: 'token_rejected' });
    h.tg.setScript(null);
    const lookup = await h.post('/api/subscription/lookup', { token: SUB_TOKEN, chatId: SUB_CHAT_ID });
    assert.deepEqual(await lookup.json(), { planIds: ['lax-as3-pocket'] }, 'stored row byte-unchanged after the 422');

    // The §B1 heal path: a disabled row + a successful (receipt-proved) update → re-enabled.
    const db = h.db();
    db.prepare('UPDATE subscribers SET disabled = 1, fail_count = 4').run();
    db.close();
    assert.equal((await h.post('/api/subscription/update', { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] })).status, 200);
    const db2 = h.db();
    const row = db2.prepare('SELECT disabled, fail_count FROM subscribers').get();
    db2.close();
    assert.equal(row.disabled, 0, 'update re-proved delivery → re-enabled');
    assert.equal(row.fail_count, 0);
  } finally {
    await h.close();
  }
});

test('SUB-I7: delete is silent and cascading — the row and its pending digests vanish, zero Telegram calls', async () => {
  const h = await makeSubServer();
  try {
    await h.push(FIXTURE_STATE);
    await h.post('/api/subscribe', { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] });
    const db = h.db();
    const subId = db.prepare('SELECT id FROM subscribers').get().id;
    db.prepare('INSERT INTO digest_queue (subscriber_id, plan_ids, created_at, attempts) VALUES (?, ?, ?, 0)').run(subId, '["lax-as3-tiny"]', T0);
    db.close();
    const before = h.tg.calls.length;
    const res = await h.post('/api/subscription/delete', { token: SUB_TOKEN, chatId: SUB_CHAT_ID });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(h.tg.calls.length, before, 'unsubscribe sends nothing (orchestrator default #2)');
    const db2 = h.db();
    assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM subscribers').get().n, 0, 'row gone');
    assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM digest_queue').get().n, 0, 'pending digest cascaded');
    db2.close();
  } finally {
    await h.close();
  }
});

test('SUB-I8: anti-oracle — all nine manage-route failure combinations return the byte-identical 404', async () => {
  const h = await makeSubServer();
  try {
    await h.push(FIXTURE_STATE);
    await h.post('/api/subscribe', { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] });
    const before = h.tg.calls.length;
    const combos = [
      { token: stok(21), chatId: SUB_CHAT_ID }, // wrong token
      { token: SUB_TOKEN, chatId: '4400000099' }, // wrong chat id
      { token: stok(22), chatId: '4400000098' }, // no row at all
    ];
    const bodies = new Set();
    for (const route of ['/api/subscription/lookup', '/api/subscription/update', '/api/subscription/delete']) {
      for (const combo of combos) {
        const payload = route.endsWith('update') ? { ...combo, planIds: ['lax-as3-tiny'] } : combo;
        const res = await h.post(route, payload);
        assert.equal(res.status, 404, `${route} ${JSON.stringify(combo)}`);
        bodies.add(await res.text());
      }
    }
    assert.equal(bodies.size, 1, 'one body for every failure cause');
    assert.deepEqual(JSON.parse([...bodies][0]), { error: 'not found' });
    assert.equal(h.tg.calls.length, before, 'no timing-relevant Telegram calls anywhere');
  } finally {
    await h.close();
  }
});

test('SUB-I9: rate limits — 6/h/IP + 4/h/token-hash on subscribe; the IP bucket answers BEFORE the body is read', async () => {
  const h = await makeSubServer();
  try {
    await h.push(FIXTURE_STATE);
    const oneIp = '203.0.113.50';
    for (let i = 1; i <= 6; i++) {
      const res = await h.post('/api/subscribe', { token: stok(30 + i), chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] }, { ip: oneIp });
      assert.equal(res.status, 200, `subscribe #${i} from one IP`);
    }
    const seventh = await h.post('/api/subscribe', { token: stok(37), chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] }, { ip: oneIp });
    assert.equal(seventh.status, 429, 'the 7th from one IP');
    assert.match(seventh.headers.get('retry-after'), /^\d+$/, '429 carries Retry-After seconds');

    const shared = stok(40);
    for (let i = 1; i <= 4; i++) {
      const res = await h.post('/api/subscribe', { token: shared, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] }, { ip: `198.51.100.${i}` });
      assert.equal(res.status, 200, `shared-token subscribe #${i}`);
    }
    const before = h.tg.calls.length;
    const fifth = await h.post('/api/subscribe', { token: shared, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] }, { ip: '198.51.100.5' });
    assert.equal(fifth.status, 429, 'the 5th with one token (4/h/token-hash)');
    assert.equal(h.tg.calls.length, before, 'post-parse, pre-Telegram — the recorder gained nothing');

    // With the IP bucket exhausted, a request that NEVER sends its declared
    // body is answered 429 immediately — the pre-body check, not a 408 wait.
    const port = Number(new URL(h.base).port);
    const started = Date.now();
    const status = await new Promise((resolve, reject) => {
      const sock = createConnection(port, '127.0.0.1', () => {
        sock.write(
          'POST /api/subscribe HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            `X-Forwarded-For: ${oneIp}\r\n` +
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
    assert.equal(status, 429);
    assert.ok(Date.now() - started < 1500, 'answered immediately, not after a body timeout');
  } finally {
    await h.close();
  }
});

test('SUB-I10: /api/chatid — int64-safe string discovery, 409/no-chat mapping, and both rate-limit families', async () => {
  const h = await makeSubServer();
  try {
    // A chat id beyond 2^53 must survive VERBATIM — asserted on the raw text.
    h.tg.setScript(() => ({ raw: '{"ok":true,"result":[{"update_id":7,"message":{"chat":{"id":5300000000123456789},"text":"hi"}}]}' }));
    const res = await h.post('/api/chatid', { token: SUB_TOKEN });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(raw.includes('"chatId":"5300000000123456789"'), `chatId rides as a JSON string, digits intact (got ${raw})`);

    h.tg.setScript(() => ({ status: 409, body: { ok: false, error_code: 409, description: 'Conflict: webhook is active' } }));
    const conflicted = await h.post('/api/chatid', { token: stok(50) });
    assert.equal(conflicted.status, 422);
    assert.deepEqual(await conflicted.json(), { reason: 'no_chat' }, 'Telegram 409 (webhook set) → no_chat');

    h.tg.setScript(() => ({ raw: '{"ok":true,"result":[]}' }));
    const empty = await h.post('/api/chatid', { token: stok(51) });
    assert.equal(empty.status, 422);
    assert.deepEqual(await empty.json(), { reason: 'no_chat' }, 'empty updates → no_chat');

    h.tg.setScript(null);
    const oneIp = '198.51.100.77';
    for (let i = 1; i <= 5; i++) {
      assert.equal((await h.post('/api/chatid', { token: stok(60 + i) }, { ip: oneIp })).status, 200, `chatid #${i} one IP`);
    }
    assert.equal((await h.post('/api/chatid', { token: stok(66) }, { ip: oneIp })).status, 429, 'the 6th/IP (5/h/IP)');
    const shared = stok(70);
    for (let i = 1; i <= 3; i++) {
      assert.equal((await h.post('/api/chatid', { token: shared }, { ip: `192.0.2.${i}` })).status, 200, `shared-token chatid #${i}`);
    }
    assert.equal((await h.post('/api/chatid', { token: shared }, { ip: '192.0.2.9' })).status, 429, 'the 4th/token (3/h/token-hash)');
  } finally {
    await h.close();
  }
});

test('SUB-I11: the 500-row cap rejects a NEW create with reason cap and no Retry-After; merges are exempt', async () => {
  const h = await makeSubServer();
  try {
    await h.push(FIXTURE_STATE);
    const db = h.db();
    const insert = db.prepare(
      'INSERT INTO subscribers (lookup_hash, token_ct, token_iv, chat_id, plan_ids, created_at, disabled, fail_count) VALUES (?, ?, ?, ?, ?, ?, 0, 0)',
    );
    insert.run(lookupHash(SUB_TOKEN, SUB_CHAT_ID), Buffer.from('ct'), Buffer.from('iv'), SUB_CHAT_ID, '["lax-as3-tiny"]', T0);
    for (let i = 1; i < 500; i++) {
      insert.run(randomBytes(32), Buffer.from('ct'), Buffer.from('iv'), String(4400001000 + i), '["lax-as3-tiny"]', T0);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscribers').get().n, 500);
    db.close();

    const rejected = await h.post('/api/subscribe', { token: stok(80), chatId: '4409999999', planIds: ['lax-as3-tiny'] });
    assert.equal(rejected.status, 429);
    assert.deepEqual(await rejected.json(), { reason: 'cap', error: 'subscriber cap reached' });
    assert.equal(rejected.headers.get('retry-after'), null, 'not a time-window limit — no Retry-After');

    const merged = await h.post('/api/subscribe', { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-pocket'] });
    assert.equal(merged.status, 200, 'cap is checked on the INSERT path only — merges pass');
    assert.equal((await merged.json()).merged, true);
  } finally {
    await h.close();
  }
});

test('SUB-I12: TOKEN_KEY absent or malformed → all five routes 503 while board/push/state serve; one boot warn', async () => {
  for (const [label, tokenKey] of [['absent', undefined], ['63-hex-chars', '5'.repeat(63)]]) {
    const h = await makeSubServer({ tokenKey });
    try {
      assert.equal(h.logs.filter((l) => /TOKEN_KEY/.test(l)).length, 1, `${label}: exactly one boot warn`);
      assert.ok(!h.logs.some((l) => l.includes('5'.repeat(63))), 'the key value is never logged');
      for (const route of ['/api/subscribe', '/api/chatid', '/api/subscription/lookup', '/api/subscription/update', '/api/subscription/delete']) {
        const res = await h.post(route, { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] });
        assert.equal(res.status, 503, `${label}: ${route}`);
        assert.deepEqual(await res.json(), { error: 'subscriptions not configured' });
      }
      assert.equal((await h.push(FIXTURE_STATE)).status, 200, `${label}: push serves`);
      assert.equal((await fetch(h.base + '/api/state')).status, 200);
      assert.equal((await fetch(h.base + '/healthz')).status, 200);
      assert.equal((await fetch(h.base + '/')).status, 200, 'static serves');
      assert.equal(h.tg.calls.length, 0);
    } finally {
      await h.close();
    }
  }
});

test('SUB-I13: the push runs the diff and never waits on Telegram; disarm + enqueue land in the window txn', async () => {
  const h = await makeSubServer({ telegramTimeoutMs: 60 });
  try {
    await h.push(FIXTURE_STATE); // plan lax-as3-tiny is OUT in the fixture → seeded armed
    await h.post('/api/subscribe', { token: SUB_TOKEN, chatId: SUB_CHAT_ID, planIds: ['lax-as3-tiny'] });
    h.tg.setScript(() => 'hang'); // Telegram wedged solid
    const started = Date.now();
    const res = await h.push(h.flip(FIXTURE_STATE, { 'lax-as3-tiny': 'in' }));
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started < 1000, 'the push response never waits on Telegram (dispatch is async)');
    await h.settle();
    const db = h.db();
    const edge = db.prepare("SELECT * FROM plan_edges WHERE plan_id = 'lax-as3-tiny'").get();
    const queued = db.prepare('SELECT COUNT(*) AS n FROM digest_queue').get().n;
    db.close();
    assert.equal(edge.armed, 0, 'disarmed in the window-close transaction');
    assert.equal(edge.last_known, 'IN');
    assert.equal(queued, 1, 'the digest row exists (crash-safe outbox)');
  } finally {
    await h.close();
  }
});

test('SUB-I15: envelope cadenceSec — accepted, sanitized, persisted, passed through; back-compat is null', async () => {
  const h = await makeSubServer();
  try {
    const stateOf = async () => (await (await fetch(h.base + '/api/state')).json()).cadenceSec;
    assert.equal((await h.push(FIXTURE_STATE, { cadenceSec: 300 })).status, 200);
    assert.equal(await stateOf(), 300, 'honest passthrough');
    assert.equal((await h.push(FIXTURE_STATE)).status, 200, 'a round-1 envelope without the field is accepted verbatim');
    assert.equal(await stateOf(), null, 'rolling deploy can never make the page lie (D7)');
    assert.equal((await h.push(FIXTURE_STATE, { cadenceSec: -5 })).status, 200, 'invalid values are sanitized, never a rejection');
    assert.equal(await stateOf(), null);
    assert.equal((await h.push(FIXTURE_STATE, { cadenceSec: 'soon' })).status, 200);
    assert.equal(await stateOf(), null);
    // Persistence: cadenceSec survives the snapshot mirror across a restart.
    assert.equal((await h.push(FIXTURE_STATE, { cadenceSec: 300 })).status, 200);
    const persisted = JSON.parse(readFileSync(join(h.dir, 'snapshot.json'), 'utf8'));
    assert.equal(persisted.cadenceSec, 300);
  } finally {
    await h.close();
  }
});

// ---- deletion tripwire (§Q3.2) ------------------------------------------------------

test('deletion tripwire: each of the six rewritten round-1 invariants still exists by test name', () => {
  const here = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'board-page.test.js'), 'utf8');
  const titles = [...(here + page).matchAll(/test\('([^']+)'/g)].map((m) => m[1]).join('\n');
  for (const [label, re] of [
    ['static allowlist', /static.*allowlist/],
    ['runtime egress', /egress/],
    ['route manifest', /route manifest/],
    ['warming deepEqual', /warming/],
    ['log hygiene', /hygiene/],
    ['freshTier boundaries', /freshTier/],
  ]) {
    assert.match(titles, re, `a rewritten invariant was deleted instead of rewritten: ${label}`);
  }
});
