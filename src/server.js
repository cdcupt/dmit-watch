// Localhost panel server (TECH §09–§11): a loopback-only HTTP + SSE surface that
// serves the static DMIT-style panel and projects the SQLite store as JSON.
//
//   GET  /                     → public/index.html (+ /js, /css static assets)
//   GET  /api/state            → full snapshot (datacenters→generations→plans)
//   GET  /api/history          → reverse-chron OUT⇄IN transitions (?limit&before)
//   GET  /api/health           → Chrome session · scheduler tick · family poll · telegram
//   GET  /events               → SSE stream (snapshot|plan|alert|watcher|history)
//   POST /api/silence          → {id}      clear a plan's alarm (relocate to "in stock now")
//   POST /api/watchlist/remove → {family}  drop a family from config + reload + re-broadcast
//
// The server is the single source of truth for the panel: it never re-derives
// stock. `broadcast(eventName, payload)` is the hook the scheduler (src/scheduler.js)
// calls on every watcher event; this module translates those into browser SSE
// events so the on-panel alarm and the Telegram alert fire off the exact same edge.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';
import { PUBLIC_DIR, WATCHLIST_FILE } from './paths.js';
import { loadWatchlist, removeFamilyFromWatchlist, writeWatchlist } from './config.js';
import { buildState, buildHistory, buildHealth, planDeltaFor, latestHistoryRow, watcherView } from './state.js';
import { readJsonBody, BODY_READ_TIMEOUT_MS } from './http-body.js';

const DEFAULT_PORT = 7331;
const SSE_PING_MS = 25_000;

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
});

// Loopback-only: bound to 127.0.0.1, plus a Host guard against DNS-rebinding.
const SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
    "img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
    "connect-src 'self'; form-action 'self'",
});

function isLoopbackHost(hostHeader) {
  if (!hostHeader) return true; // some clients omit it on loopback
  const host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

// CSRF guard for state-changing POSTs. The loopback bind + Host guard stop
// DNS-rebinding, but a malicious page can still fire a "simple" cross-origin
// POST (text/plain / form) at http://127.0.0.1:<port> with no preflight. We
// accept a write only when it is provably same-origin: Sec-Fetch-Site (when the
// browser sends it) must be same-origin/none, and any Origin header must equal
// our own loopback origin (Origin host === our Host). GETs are never guarded.
function isSameOriginWrite(req) {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  const origin = req.headers.origin;
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host; // host[:port]
    } catch {
      return false; // unparseable Origin -> treat as cross-site
    }
    if (originHost.toLowerCase() !== String(req.headers.host ?? '').toLowerCase()) return false;
  }
  return true;
}

// Require an application/json body: rejects text/plain and form submissions, the
// only content types a cross-site page can send without triggering a CORS preflight.
function isJsonRequest(req) {
  return String(req.headers['content-type'] ?? '')
    .toLowerCase()
    .startsWith('application/json');
}

function sendJson(res, status, obj, extraHeaders) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extraHeaders });
  res.end(body);
}

/**
 * @param {object} opts
 * @param {object} opts.store         SQLite store facade (src/store.js)
 * @param {object} opts.watchlist     parsed config/watchlist.json (becomes the live, mutable ref)
 * @param {string} [opts.watchlistPath] path to persist removals to
 * @param {string} [opts.publicDir]   static asset root
 * @param {number} [opts.port]        defaults to settings.panelPort || 7331; pass 0 for an ephemeral test port
 * @param {string} [opts.host]        bind address; defaults to 127.0.0.1 (loopback only)
 * @param {object} [opts.logger]
 * @param {number} [opts.bodyTimeoutMs] max wait for a POST body before 408 (default 10s)
 */
export function createPanelServer({
  store,
  watchlist,
  watchlistPath = WATCHLIST_FILE,
  publicDir = PUBLIC_DIR,
  port,
  host = '127.0.0.1',
  logger = console,
  bodyTimeoutMs = BODY_READ_TIMEOUT_MS,
} = {}) {
  if (!store) throw new Error('createPanelServer: store is required');
  if (!watchlist) throw new Error('createPanelServer: watchlist is required');

  let current = watchlist; // mutated on watchlist/remove
  const listenPort = port ?? current.settings?.panelPort ?? DEFAULT_PORT;
  const alarmed = new Set(); // plan ids with an un-silenced active alarm (server-owned)
  const clients = new Set(); // open SSE responses

  // ---- SSE plumbing --------------------------------------------------------
  function writeEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function sse(event, data) {
    for (const res of clients) {
      try {
        writeEvent(res, event, data);
      } catch {
        clients.delete(res);
      }
    }
  }
  const snapshot = () => buildState({ watchlist: current, store, alarmed });

  // ---- scheduler → browser event bridge ------------------------------------
  const pushPlan = (id) => {
    const d = planDeltaFor(id, { watchlist: current, store, alarmed });
    if (d) sse('plan', d);
  };
  const pushHistory = (id) => {
    const h = latestHistoryRow(id, { watchlist: current, store });
    if (h) sse('history', h);
  };
  const pushWatcher = (extra) => sse('watcher', { ...watcherView(store), ...extra });

  function onEdge({ plan, family, deepLink } = {}) {
    const id = plan?.id;
    if (!id) return;
    alarmed.add(id);
    pushPlan(id);
    sse('alert', {
      id,
      name: plan?.name ?? id,
      deepLink: deepLink ?? plan?.deepLink ?? '',
      city: family?.city ?? '',
      cpu: family?.cpu ?? '',
      price: plan?.price ?? '',
    });
    pushHistory(id);
    pushWatcher();
  }
  function onRearm({ plan } = {}) {
    const id = plan?.id;
    if (!id) return;
    alarmed.delete(id);
    pushPlan(id);
    pushHistory(id);
    pushWatcher();
  }
  function onFamily({ family } = {}) {
    for (const p of current.plans ?? []) if (p.family === family) pushPlan(p.id);
    pushWatcher();
  }
  function onBlind({ family, reasons } = {}, blind) {
    pushWatcher({ blind, family: family?.key, reasons: reasons ?? [] });
  }

  /** The hook handed to the scheduler (broadcast(eventName, payload)). */
  function broadcast(eventName, payload) {
    try {
      switch (eventName) {
        case 'edge': return onEdge(payload);
        case 'rearm': return onRearm(payload);
        case 'family': return onFamily(payload);
        case 'cycle':
        case 'error': return pushWatcher();
        case 'blind': return onBlind(payload, true);
        case 'blind:cleared': return onBlind(payload, false);
        default: return undefined;
      }
    } catch (err) {
      logger?.warn?.(`[server] broadcast ${eventName} failed: ${err.message}`);
      return undefined;
    }
  }

  // ---- static assets -------------------------------------------------------
  async function serveStatic(res, pathname) {
    const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(publicDir, rel);
    if (!filePath.startsWith(publicDir)) return sendJson(res, 403, { error: 'forbidden' });
    try {
      const body = await readFile(filePath);
      const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, ...SECURITY_HEADERS });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('Not found');
    }
  }

  // ---- POST handlers -------------------------------------------------------
  async function handleSilence(req, res) {
    const body = await readJsonBody(req, bodyTimeoutMs);
    const id = body?.id;
    if (!id || typeof id !== 'string') return sendJson(res, 400, { error: 'missing plan id' });
    // Only silence a plan we actually watch — an unknown id is a 404, not a fake ok.
    if (!(current.plans ?? []).some((p) => p.id === id)) {
      return sendJson(res, 404, { ok: false, error: 'unknown plan id' });
    }
    alarmed.delete(id);
    pushPlan(id); // alarm:false → card relocates to "In stock now"
    sendJson(res, 200, { ok: true, id });
  }

  async function handleWatchlistRemove(req, res) {
    const body = await readJsonBody(req, bodyTimeoutMs);
    const family = body?.family;
    if (!family || typeof family !== 'string') return sendJson(res, 400, { error: 'missing family key' });

    let previous;
    try {
      previous = JSON.stringify(current, null, 2);
      const next = removeFamilyFromWatchlist(current, family); // throws on bad/empty
      writeWatchlist(next, watchlistPath);
      current = loadWatchlist(watchlistPath); // same reload a manual edit triggers
    } catch (err) {
      if (previous != null) {
        try {
          writeWatchlist(JSON.parse(previous), watchlistPath);
        } catch {
          /* best effort restore */
        }
      }
      return sendJson(res, 400, { error: err.message });
    }
    sse('snapshot', snapshot()); // every open panel drops the removed plans
    sendJson(res, 200, { ok: true, families: (current.families ?? []).map((f) => f.key) });
  }

  // ---- request router ------------------------------------------------------
  async function onRequest(req, res) {
    if (!isLoopbackHost(req.headers.host)) return sendJson(res, 403, { error: 'loopback only' });
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    // Every branch is awaited inside this try so a handler rejection (bad body,
    // store error, anything) becomes an HTTP status — a request must NEVER throw
    // out of the server callback (that would crash the always-on process).
    try {
      if (req.method === 'GET') {
        switch (pathname) {
          case '/api/state':
            return sendJson(res, 200, snapshot());
          case '/api/history': {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
            const before = Number(url.searchParams.get('before')) || null;
            return sendJson(res, 200, buildHistory({ watchlist: current, store, limit, before }));
          }
          case '/api/health':
            return sendJson(res, 200, buildHealth({ watchlist: current, store }));
          case '/events':
            return openSse(req, res);
          default:
            return await serveStatic(res, pathname);
        }
      }
      if (req.method === 'POST') {
        // CSRF: reject cross-site writes and non-JSON ("simple request") bodies.
        if (!isSameOriginWrite(req)) return sendJson(res, 403, { error: 'cross-site request blocked' });
        if (!isJsonRequest(req)) return sendJson(res, 403, { error: 'content-type must be application/json' });
        if (pathname === '/api/silence') return await handleSilence(req, res);
        if (pathname === '/api/watchlist/remove') return await handleWatchlistRemove(req, res);
        return sendJson(res, 404, { error: 'not found' });
      }
      res.writeHead(405, { allow: 'GET, POST', ...SECURITY_HEADERS });
      res.end();
    } catch (err) {
      // Body-boundary errors (413/400/408) reply with their own status + close the
      // connection (a half-read body can't poison a keep-alive socket); anything
      // else is unexpected → 500 (logged, no internal detail leaked).
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      if (status === 500) logger?.error?.(`[server] ${req.method} ${pathname}: ${err?.message}`);
      sendJson(res, status, { error: status === 500 ? 'internal error' : err.message }, status === 500 ? undefined : { connection: 'close' });
    }
  }

  function openSse(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      ...SECURITY_HEADERS,
    });
    res.write(': connected\n\n');
    writeEvent(res, 'snapshot', snapshot()); // resync on (re)connect — never stale
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  const server = createServer(onRequest);
  let pinger = null;

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(listenPort, host, () => {
        pinger = setInterval(() => sse('ping', { t: Date.now() }), SSE_PING_MS);
        if (typeof pinger.unref === 'function') pinger.unref();
        const addr = server.address();
        logger?.log?.(`[server] panel on http://${host}:${addr.port} (${(current.plans ?? []).length} plans)`);
        resolve(addr.port);
      });
    });
  }

  async function stop() {
    if (pinger) clearInterval(pinger);
    for (const res of clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
    await new Promise((resolve) => server.close(resolve));
  }

  return {
    start,
    stop,
    broadcast,
    server,
    get port() {
      return server.address()?.port ?? listenPort;
    },
    get watchlist() {
      return current;
    },
  };
}
