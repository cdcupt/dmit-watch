// Public VPS stock board server (TECH §4): the one deployable file behind
// vps-stock.daichenlab.com. Holds the latest watcher-pushed snapshot in memory,
// mirrors it to a single atomically-written JSON file for restart survival, and
// serves a read-only public surface plus exactly one token-gated write:
//
//   GET  /            → board page (board-server/public/index.html + assets)
//   GET  /api/state   → {v, pushedAt, receivedAt, now, state}   (no-store)
//   GET  /healthz     → {ok, receivedAt, ageMs}                 (no-store)
//   POST /api/push    → Bearer-gated snapshot intake (the ONLY mutating route)
//
// SELF-CONTAINED on the Node stdlib (node:http/crypto/fs/path) — deliberately
// imports NOTHING from src/ so the deployable unit is this one directory with
// zero node_modules. The sendJson/SECURITY_HEADERS/router-try-catch idioms are
// rewritten from src/server.js, and the body reader is copied from
// src/http-body.js (provenance comments below). Deliberately NOT ported from
// the panel: the loopback Host guard (this server answers a public hostname
// behind Caddy) and the CSRF Origin/Sec-Fetch-Site guard (no cookies, no
// browser-initiated writes — the bearer token is the entire write-auth story).

import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '0.0.0.0'; // in-container bind; loopback exposure is the compose port map's job

// Copied from src/http-body.js (deliberate DRY exception — deployment isolation
// wins: this directory must run with zero imports from src/). Same numbers.
const MAX_BODY_BYTES = 64 * 1024;
const BODY_READ_TIMEOUT_MS = 10_000;

const WARN_THROTTLE_MS = 60_000; // write-failure + 401-flood log coalescing window

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
});

// Static allowlist: the board bundle is exactly these five files (favicon is an
// inline data: URI in the page). Anything else — traversal, encodings, panel
// paths — is a 404 by construction, not by sanitization.
const STATIC_ROUTES = Object.freeze({
  '/': 'index.html',
  '/board.css': 'board.css',
  '/js/board.js': 'js/board.js',
  '/js/render.js': 'js/render.js',
  '/js/util.js': 'js/util.js',
});

// Same shape as the panel's block (src/server.js), minus inline styles — the
// board has no inline scripts or styles, and it never submits a form.
const SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
    "img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; form-action 'none'",
});

// Served for GET / while board-server/public is absent (the board page ships in
// a separate slice; a bare server deploy must still answer with a clean status).
const PLACEHOLDER_503 =
  '<!doctype html><meta charset="utf-8"><title>VPS Stock Watch</title>' +
  '<p>Board assets are not deployed yet — the API is up at <code>/api/state</code>.</p>';

const sha256 = (value) => createHash('sha256').update(String(value)).digest();

function sendJson(res, status, obj, extraHeaders) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extraHeaders });
  res.end(body);
}

function sendMethodNotAllowed(res, allow) {
  res.writeHead(405, { allow, ...SECURITY_HEADERS });
  res.end();
}

// ---- body reader — copied from src/http-body.js (deliberate DRY exception) --
// A malformed, oversized, or stalled body must produce a clean HTTP status (not
// a hung request or an unhandledRejection): over MAX_BODY_BYTES → 413, invalid
// JSON → 400, no body within timeoutMs → 408. Settles exactly once; the awaited
// router turns the boundary error into an HTTP response.
function bodyError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function readJsonBody(req, timeoutMs = BODY_READ_TIMEOUT_MS) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, bodyError(408, 'request body read timed out')), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        finish(reject, bodyError(413, 'request body too large')); // stop accumulating
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return finish(resolvePromise, {});
      try {
        finish(resolvePromise, JSON.parse(raw));
      } catch {
        finish(reject, bodyError(400, 'invalid JSON body'));
      }
    });
    req.on('error', (err) => finish(reject, err));
  });
}

// ---- push envelope + persisted-doc shape guards ------------------------------
// Only the fields the envelope contract names are validated; the plan tree is
// not deep-validated (forward compatible — the board renders defensively and
// the only writer is the token-holding watcher).
const isValidEnvelope = (b) =>
  b != null && b.v === 1 && Number.isFinite(b.pushedAt) && b.state != null && Array.isArray(b.state.datacenters);

const isValidDoc = (d) =>
  d != null && Number.isFinite(d.receivedAt) && d.state != null && Array.isArray(d.state.datacenters);

/** Throttled warn: logs at most once per windowMs, folding suppressed repeats in. */
function throttledWarn(logger, now, windowMs = WARN_THROTTLE_MS) {
  let lastAt = -Infinity;
  let suppressed = 0;
  return (msg) => {
    if (now() - lastAt < windowMs) {
      suppressed += 1;
      return;
    }
    logger?.warn?.(suppressed > 0 ? `${msg} (+${suppressed} suppressed)` : msg);
    lastAt = now();
    suppressed = 0;
  };
}

/**
 * @param {object} opts
 * @param {number} [opts.port]        listen port; pass 0 for an ephemeral test port
 * @param {string} [opts.host]        bind address (default 0.0.0.0 — see note above)
 * @param {string} [opts.token]       bearer token for POST /api/push; ABSENT → fail-closed 401s
 * @param {string} opts.snapshotFile  durable snapshot mirror ({v, pushedAt, receivedAt, state})
 * @param {string} [opts.staticDir]   board bundle root (default: public/ beside this file)
 * @param {Function} [opts.now]       clock, injectable for tests
 * @param {object} [opts.logger]
 * @param {number} [opts.bodyTimeoutMs] max wait for the push body before 408
 */
export function createBoardServer({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  token,
  snapshotFile,
  staticDir = join(dirname(fileURLToPath(import.meta.url)), 'public'),
  now = Date.now,
  logger = console,
  bodyTimeoutMs = BODY_READ_TIMEOUT_MS,
} = {}) {
  if (!snapshotFile) throw new Error('createBoardServer: snapshotFile is required');

  // Hash the configured token once at boot; per request hash the presented
  // credential and compare digests with timingSafeEqual — hashing first
  // guarantees equal-length buffers (timingSafeEqual throws on length mismatch)
  // and leaks neither content nor length. Empty/absent token → fail-closed.
  const tokenDigest = token ? sha256(token) : null;
  const staticRoot = resolve(staticDir);

  let latest = null; // {v, pushedAt, receivedAt, state} — replaced wholesale per accepted push
  let writeChain = Promise.resolve(); // serializes snapshot writes so pushes never interleave
  const warnWriteFailure = throttledWarn(logger, now);
  const warnUnauthorized = throttledWarn(logger, now);

  function isAuthorized(req) {
    if (!tokenDigest) return false; // no token configured → every push 401s, reads keep serving
    const header = String(req.headers.authorization ?? '');
    if (!header.startsWith('Bearer ')) return false;
    return timingSafeEqual(sha256(header.slice(7)), tokenDigest);
  }

  // ---- snapshot store: memory first, one file for restarts ------------------
  async function loadSnapshot() {
    let raw;
    try {
      raw = await readFile(snapshotFile, 'utf8');
    } catch {
      return; // missing file → warming up, a designed state
    }
    try {
      const doc = JSON.parse(raw);
      if (!isValidDoc(doc)) throw new Error('wrong shape');
      latest = doc; // persisted receivedAt kept — a restart never fakes freshness
      logger?.log?.(`[board] loaded snapshot from disk (receivedAt=${doc.receivedAt})`);
    } catch {
      // Corrupt/unparseable → rename aside and start empty; never crash the boot.
      await rename(snapshotFile, `${snapshotFile}.corrupt`).catch(() => {});
      logger?.warn?.(`[board] snapshot file unreadable — moved to ${basename(snapshotFile)}.corrupt, starting empty`);
    }
  }

  // Atomic mirror: write the sibling .tmp then rename() over the real file —
  // readers and crashes see either the old doc or the new one, never a torn
  // write. Failures degrade durability, never availability (memory still serves).
  function persist(doc) {
    writeChain = writeChain
      .then(async () => {
        const tmp = `${snapshotFile}.tmp`;
        await writeFile(tmp, JSON.stringify(doc));
        await rename(tmp, snapshotFile);
      })
      .catch((err) => warnWriteFailure(`[board] snapshot write failed: ${err.message}`));
    return writeChain; // never rejects
  }

  // ---- views -----------------------------------------------------------------
  const stateView = () => ({
    v: latest?.v ?? null,
    pushedAt: latest?.pushedAt ?? null,
    receivedAt: latest?.receivedAt ?? null,
    now: now(), // lets the board compute age without trusting the visitor's clock
    state: latest?.state ?? null,
  });

  const healthView = () => ({
    ok: true, // "service up", not "data fresh" — the monitor keys staleness off ageMs
    receivedAt: latest?.receivedAt ?? null,
    ageMs: latest ? Math.max(0, now() - latest.receivedAt) : null,
  });

  // ---- handlers ----------------------------------------------------------------
  async function handlePush(req, res) {
    if (!isAuthorized(req)) {
      // Uniform 401 regardless of which check failed; floods coalesce to one
      // throttled counter-style line so a scanner can't flood the log.
      warnUnauthorized('[board] rejected unauthorized push');
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    const body = await readJsonBody(req, bodyTimeoutMs); // 400/408/413 reject into the router catch
    if (!isValidEnvelope(body)) return sendJson(res, 422, { error: 'unprocessable snapshot' });

    const doc = { v: body.v, pushedAt: body.pushedAt, receivedAt: now(), state: body.state };
    latest = doc; // immutable swap — no field-level mutation of the previous doc
    await persist(doc); // settled (ok or logged failure) before we answer, so the mirror is deterministic
    const dcs = doc.state.datacenters;
    const plans = dcs.reduce((n, dc) => n + (dc.generations ?? []).reduce((m, g) => m + (g.plans?.length ?? 0), 0), 0);
    logger?.log?.(`[board] push accepted: ${plans} plans / ${dcs.length} datacenters (receivedAt=${doc.receivedAt})`);
    sendJson(res, 200, { ok: true, receivedAt: doc.receivedAt });
  }

  async function serveStatic(res, pathname) {
    const rel = STATIC_ROUTES[pathname];
    if (!rel) return sendJson(res, 404, { error: 'not found' });
    // Defense-in-depth behind the allowlist: the resolved target must stay
    // inside the static root (resolve + prefix check, as in src/server.js).
    const filePath = resolve(staticRoot, rel);
    if (filePath !== staticRoot && !filePath.startsWith(staticRoot + sep)) {
      return sendJson(res, 404, { error: 'not found' });
    }
    const cacheControl = pathname === '/' ? 'no-cache' : 'public, max-age=300';
    try {
      const body = await readFile(filePath);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[rel.slice(rel.lastIndexOf('.'))] ?? 'application/octet-stream',
        'cache-control': cacheControl,
        ...SECURITY_HEADERS,
      });
      res.end(body);
    } catch {
      if (pathname === '/') {
        // Board bundle not deployed (separate slice) — still answer cleanly.
        res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
        res.end(PLACEHOLDER_503);
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    }
  }

  // ---- request router ----------------------------------------------------------
  async function onRequest(req, res) {
    // Every branch is awaited inside this try so a handler rejection (bad body,
    // fs error, anything) becomes an HTTP status — a request must NEVER throw
    // out of the server callback (that would crash the always-on process).
    try {
      const { pathname } = new URL(req.url, 'http://board'); // normalizes dot segments
      if (pathname === '/api/push') {
        if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST');
        return await handlePush(req, res);
      }
      // Public surface is GET-only; HEAD is routed like GET (Node suppresses the
      // body for HEAD responses automatically) so naive uptime probes work.
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(res, 'GET');
      if (pathname === '/api/state') return sendJson(res, 200, stateView(), { 'cache-control': 'no-store' });
      if (pathname === '/healthz') return sendJson(res, 200, healthView(), { 'cache-control': 'no-store' });
      return await serveStatic(res, pathname);
    } catch (err) {
      // Body-boundary errors (400/408/413) reply with their own status + close
      // the connection (a half-read body can't poison a keep-alive socket);
      // anything else is unexpected → 500 (logged, no internal detail leaked).
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      if (status === 500) logger?.error?.(`[board] ${req.method} ${req.url}: ${err?.message}`);
      sendJson(res, status, { error: status === 500 ? 'internal error' : err.message }, status === 500 ? undefined : { connection: 'close' });
    }
  }

  const server = createServer(onRequest);

  function start() {
    return new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      loadSnapshot().then(() => {
        if (!tokenDigest) {
          logger?.warn?.('[board] PUSH_TOKEN not configured — every push will be rejected 401 (reads keep serving)');
        }
        server.listen(port, host, () => {
          const addr = server.address();
          logger?.log?.(`[board] public stock board on http://${host}:${addr.port}`);
          resolvePromise(addr.port);
        });
      });
    });
  }

  async function stop() {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    await writeChain; // let an in-flight mirror write settle before we return
  }

  return { start, stop, address: () => server.address() };
}

// ---- CLI entry (container: `node /app/server.js`) ----------------------------
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createBoardServer({
    port: Number(process.env.PORT) || DEFAULT_PORT,
    host: process.env.HOST || DEFAULT_HOST,
    token: process.env.PUSH_TOKEN,
    snapshotFile: process.env.SNAPSHOT_FILE || '/data/snapshot.json',
  });
  server.start().catch((err) => {
    console.error(`[board] failed to start: ${err.message}`);
    process.exit(1);
  });
  const shutdown = (signal) => {
    console.log(`[board] ${signal} — shutting down`);
    server.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
