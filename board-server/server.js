// Public VPS stock board server (round-1 TECH §4 + round-2 TECH §B0-§B5): the
// deployable unit behind vps-stock.daichenlab.com. Holds the latest
// watcher-pushed snapshot in memory, mirrors it to one atomically-written JSON
// file, runs the push-time edge diff, and serves the public surface. The
// mutating surface is the D8 allowlist — /api/push (bearer) plus the five
// subscription POSTs; everything else stays 404/405 by construction:
//
//   GET  /            → board page (board-server/public/index.html + assets)
//   GET  /api/state   → {v, pushedAt, receivedAt, now, cadenceSec, state} (no-store)
//   GET  /healthz     → {ok, receivedAt, ageMs}                           (no-store)
//   POST /api/push    → Bearer-gated snapshot intake (+ the §B2 edge diff)
//   POST /api/subscribe            → D3-gated create/merge (confirmation card first)
//   POST /api/chatid               → getUpdates chat-id discovery
//   POST /api/subscription/lookup  → {planIds} by lookup_hash (uniform 404)
//   POST /api/subscription/update  → replace, 🔄-receipt-gated
//   POST /api/subscription/delete  → silent, idempotent, cascading
//
// SELF-CONTAINED: this directory imports only node: builtins and its own
// sibling modules (edge-detect / sub-store / notifier / rate-limit) — NOTHING
// from src/, zero node_modules. The sendJson/SECURITY_HEADERS/router-try-catch
// idioms are rewritten from src/server.js, and the body reader is copied from
// src/http-body.js (provenance comments below). Deliberately NOT ported from
// the panel: the loopback Host guard (this server answers a public hostname
// behind Caddy) and the CSRF Origin/Sec-Fetch-Site guard (no cookies; write
// auth is the bearer token or the {token, chatId} credential pair in a body).

import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STOCK, wireToStock } from './edge-detect.js';
import { openSubStore, SUBSCRIBER_CAP } from './sub-store.js';
import { buildReceiptCard, createNotifier } from './notifier.js';
import { clientIp, createFixedWindowLimiter } from './rate-limit.js';

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '0.0.0.0'; // in-container bind; loopback exposure is the compose port map's job

// Copied from src/http-body.js (deliberate DRY exception — deployment isolation
// wins: this directory must run with zero imports from src/). Same numbers.
const MAX_BODY_BYTES = 64 * 1024; // push envelopes
const SUB_BODY_MAX_BYTES = 8 * 1024; // subscription routes — a tighter cap (§B3)
const BODY_READ_TIMEOUT_MS = 10_000;

// Body shape checks match the client's relaxed formats (§B3 argued pins): the
// server is never stricter than the UI; D3's confirmation send stays the real
// authority either way. chatId is a STRING end-to-end (int64 safety).
const TOKEN_RE = /^\d{8,12}:[A-Za-z0-9_-]{30,}$/;
const CHAT_ID_RE = /^-?\d+$/;
const TOKEN_KEY_RE = /^[0-9a-fA-F]{64}$/; // 32-byte AES-256-GCM key as hex

// Per-route fixed-window budgets (§B3, orchestrator-pinned numbers).
const RATE_BUDGETS = Object.freeze({
  subscribeIp: 6,
  subscribeToken: 4,
  chatidIp: 5,
  chatidToken: 3,
  lookupIp: 20,
  updateIp: 10,
  deleteIp: 10,
});

const WARN_THROTTLE_MS = 60_000; // write-failure + 401-flood log coalescing window

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
});

// Static allowlist: the board bundle is exactly these six files (favicon is an
// inline data: URI in the page). Anything else — traversal, encodings, panel
// paths — is a 404 by construction, not by sanitization.
const STATIC_ROUTES = Object.freeze({
  '/': 'index.html',
  '/board.css': 'board.css',
  '/js/board.js': 'js/board.js',
  '/js/render.js': 'js/render.js',
  '/js/util.js': 'js/util.js',
  '/js/subscribe.js': 'js/subscribe.js', // the bundle's only POST client (round 2)
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
const sha256hex = (value) => createHash('sha256').update(String(value)).digest('hex');

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

function readJsonBody(req, timeoutMs = BODY_READ_TIMEOUT_MS, maxBytes = MAX_BODY_BYTES) {
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
      if (size > maxBytes) {
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
 * @param {string} opts.snapshotFile  durable snapshot mirror ({v, pushedAt, receivedAt, cadenceSec, state})
 * @param {string} [opts.staticDir]   board bundle root (default: public/ beside this file)
 * @param {Function} [opts.now]       clock, injectable for tests
 * @param {object} [opts.logger]
 * @param {number} [opts.bodyTimeoutMs] max wait for the push body before 408
 * @param {string} [opts.tokenKey]    64-hex AES-256-GCM key; absent/malformed → subscription routes 503
 * @param {string} [opts.subDbFile]   subscriber store (default /data/board.db; ':memory:' honored)
 * @param {Function} [opts.telegramFetch] the ONLY egress seam — every outbound Telegram call rides it
 * @param {(ms:number)=>Promise<void>} [opts.sleep] dispatcher backoff sleep (tests: instant)
 * @param {number} [opts.windowMs]    digest window (default 75 000; tests ~15)
 * @param {number} [opts.telegramTimeoutMs] per-attempt Telegram abort (default 10 000)
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
  tokenKey,
  subDbFile = '/data/board.db',
  telegramFetch = (...args) => globalThis.fetch(...args),
  sleep,
  windowMs,
  telegramTimeoutMs,
} = {}) {
  if (!snapshotFile) throw new Error('createBoardServer: snapshotFile is required');

  // Hash the configured token once at boot; per request hash the presented
  // credential and compare digests with timingSafeEqual — hashing first
  // guarantees equal-length buffers (timingSafeEqual throws on length mismatch)
  // and leaks neither content nor length. Empty/absent token → fail-closed.
  const tokenDigest = token ? sha256(token) : null;
  const staticRoot = resolve(staticDir);

  let latest = null; // {v, pushedAt, receivedAt, cadenceSec, state} — replaced wholesale per accepted push
  let writeChain = Promise.resolve(); // serializes snapshot writes so pushes never interleave
  const warnWriteFailure = throttledWarn(logger, now);
  const warnUnauthorized = throttledWarn(logger, now);
  const warnDiffFailure = throttledWarn(logger, now);

  // ---- subscriptions wiring (§B1/§B5) ----------------------------------------
  // TOKEN_KEY absent/malformed → the five subscription routes 503 while board,
  // push, and state keep serving (the PUSH_TOKEN fail-closed pattern, mirrored).
  // The key VALUE is never logged.
  const tokenKeyOk = typeof tokenKey === 'string' && TOKEN_KEY_RE.test(tokenKey);
  const limiter = createFixedWindowLimiter({ now });
  const subStore = tokenKeyOk ? openSubStore(subDbFile, { tokenKey }) : null;
  const notifier = subStore
    ? createNotifier({
        store: subStore,
        getPlanIndex: snapshotPlanIndex,
        fetch: telegramFetch,
        now,
        sleep,
        windowMs,
        sendTimeoutMs: telegramTimeoutMs,
        logger,
      })
    : null;

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
    cadenceSec: latest?.cadenceSec ?? null, // D7 — honest passthrough; null when unknown
    state: latest?.state ?? null,
  });

  /**
   * Plan index from the LATEST snapshot: id → {id, name, price, period, city,
   * deepLink} in snapshot encounter order (Map insertion order). Null while
   * warming up. Shared by plan-id validation, card builders, and the notifier.
   */
  function snapshotPlanIndex() {
    if (!latest?.state) return null;
    const index = new Map();
    for (const dc of latest.state.datacenters ?? []) {
      for (const gen of dc.generations ?? []) {
        for (const plan of gen.plans ?? []) {
          if (plan?.id == null || index.has(plan.id)) continue;
          index.set(plan.id, {
            id: plan.id,
            name: plan.name,
            price: plan.price,
            period: plan.period,
            city: dc.city,
            deepLink: plan.deepLink,
          });
        }
      }
    }
    return index;
  }

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

    // cadenceSec is sanitized, never a rejection (§B6): a not-yet-updated
    // watcher's envelope is accepted verbatim and serves cadenceSec: null.
    const cadenceSec = Number.isFinite(body.cadenceSec) && body.cadenceSec > 0 ? body.cadenceSec : null;
    const doc = { v: body.v, pushedAt: body.pushedAt, receivedAt: now(), cadenceSec, state: body.state };
    latest = doc; // immutable swap — no field-level mutation of the previous doc
    await persist(doc); // settled (ok or logged failure) before we answer, so the mirror is deterministic
    if (subStore) runEdgeDiff(doc); // sync, prepared statements only, zero network I/O (§B2)
    const dcs = doc.state.datacenters;
    const plans = dcs.reduce((n, dc) => n + (dc.generations ?? []).reduce((m, g) => m + (g.plans?.length ?? 0), 0), 0);
    logger?.log?.(`[board] push accepted: ${plans} plans / ${dcs.length} datacenters (receivedAt=${doc.receivedAt})`);
    sendJson(res, 200, { ok: true, receivedAt: doc.receivedAt });
  }

  /**
   * Push-time edge diff (§B2): every accepted push is compared against the
   * PERSISTED per-plan armed state (level-triggered, gap-tolerant). Absent rows
   * seed fire-free; UNKNOWN holds position; a fired plan joins the notifier's
   * pending window (disarm deferred to the window-close transaction); a pending
   * plan observed OUT again mid-window is retracted. A diff failure degrades
   * alerting, never the board — the push still answers 200.
   */
  function runEdgeDiff(doc) {
    const t = now();
    try {
      for (const dc of doc.state.datacenters ?? []) {
        for (const gen of dc.generations ?? []) {
          for (const plan of gen.plans ?? []) {
            if (plan?.id == null) continue;
            const { fire, stock } = subStore.observePlan(plan.id, wireToStock(plan.status), t);
            if (fire) notifier.noteFire(plan.id, t);
            else if (stock === STOCK.OUT) notifier.retract(plan.id);
          }
        }
      }
    } catch (err) {
      warnDiffFailure(`[board] edge diff failed: ${err.message}`);
    }
  }

  // ---- subscription routes (§B3) ----------------------------------------------
  // Guard order everywhere: 503-if-unconfigured → IP bucket (BEFORE the body
  // read) → body ≤ 8 KB → JSON + shape → token-hash bucket → snapshot plan-id
  // validation → cap/auth → Telegram → store. Cheapest checks first; no
  // Telegram call ever happens for malformed, rate-limited, or unknown-plan
  // requests. Credentials ride ONLY in POST bodies and are never logged.

  /** Count one hit; on rejection answer 429 + Retry-After and return true. */
  function rateLimited(res, key, limit) {
    const r = limiter.check(key, limit);
    if (r.ok) return false;
    sendJson(res, 429, { error: 'rate limited' }, { 'retry-after': String(r.retryAfterSec) });
    return true;
  }

  const cleanToken = (v) => (typeof v === 'string' && TOKEN_RE.test(v.trim()) ? v.trim() : null);
  const cleanChatId = (v) => (typeof v === 'string' && CHAT_ID_RE.test(v.trim()) ? v.trim() : null);

  /** Non-empty array of strings → de-duplicated copy (order kept); else null. */
  function cleanPlanIds(v) {
    if (!Array.isArray(v) || v.length === 0) return null;
    if (!v.every((id) => typeof id === 'string' && id.length > 0)) return null;
    return [...new Set(v)];
  }

  /** Every planId must be in the current snapshot index; null index = warming. */
  const unknownPlanId = (planIds, index) => planIds.some((id) => !index.has(id));

  async function handleSubscribe(req, res, ip) {
    if (rateLimited(res, `subscribe-ip:${ip}`, RATE_BUDGETS.subscribeIp)) return;
    const body = (await readJsonBody(req, bodyTimeoutMs, SUB_BODY_MAX_BYTES)) ?? {}; // a literal `null` body is a shape failure, not a crash
    const token = cleanToken(body.token);
    const chatId = cleanChatId(body.chatId);
    const planIds = cleanPlanIds(body.planIds);
    if (!token || !chatId || !planIds) return sendJson(res, 400, { error: 'invalid request' });
    if (rateLimited(res, `subscribe-tok:${sha256hex(token)}`, RATE_BUDGETS.subscribeToken)) return;
    const index = snapshotPlanIndex();
    if (!index) return sendJson(res, 503, { error: 'warming up' });
    if (unknownPlanId(planIds, index)) return sendJson(res, 400, { error: 'unknown plan id' });

    // Duplicate {token, chatId} = additive intent → merge by union (never an error).
    const existing = subStore.findSubscriber(token, chatId);
    const merged = existing != null;
    const stored = merged ? [...new Set([...existing.planIds, ...planIds])] : planIds;
    if (!merged && subStore.subscriberCount() >= SUBSCRIBER_CAP) {
      // Not a time-window limit → deliberately NO Retry-After (§B1).
      return sendJson(res, 429, { reason: 'cap', error: 'subscriber cap reached' });
    }

    // D3 mechanical: the confirmation card IS the validity gate — nothing is
    // stored unless the subscriber's own bot delivered it (sync, 10 s abort).
    const cardPlans = [...index.values()].filter((p) => stored.includes(p.id));
    const sent = await notifier.sendCard({ token, chatId, text: buildReceiptCard({ plans: cardPlans }) });
    if (!sent.ok) {
      if (sent.reason) return sendJson(res, 422, { reason: sent.reason });
      return sendJson(res, 502, { error: 'telegram unreachable' });
    }
    // ONLY NOW: encrypt (fresh IV) → insert/update; merge re-proves delivery,
    // so it also re-enables a disabled row (fail_count=0, disabled=0 — §B1 heal).
    if (merged) subStore.updateSubscriber(existing.id, { token, planIds: stored });
    else subStore.createSubscriber({ token, chatId, planIds: stored, now: now() });
    sendJson(res, 200, { ok: true, plans: stored, merged });
  }

  async function handleChatId(req, res, ip) {
    if (rateLimited(res, `chatid-ip:${ip}`, RATE_BUDGETS.chatidIp)) return;
    const body = (await readJsonBody(req, bodyTimeoutMs, SUB_BODY_MAX_BYTES)) ?? {}; // a literal `null` body is a shape failure, not a crash
    const token = cleanToken(body.token);
    if (!token) return sendJson(res, 400, { error: 'invalid request' });
    if (rateLimited(res, `chatid-tok:${sha256hex(token)}`, RATE_BUDGETS.chatidToken)) return;
    const found = await notifier.discoverChatId(token);
    if (!found.ok) {
      if (found.reason) return sendJson(res, 422, { reason: found.reason });
      return sendJson(res, 502, { error: 'telegram unreachable' });
    }
    // chat ids are int64 — serialized as a JSON string, never a number (§B3).
    sendJson(res, 200, { chatId: found.chatId });
  }

  async function handleLookup(req, res, ip) {
    if (rateLimited(res, `lookup-ip:${ip}`, RATE_BUDGETS.lookupIp)) return;
    const body = (await readJsonBody(req, bodyTimeoutMs, SUB_BODY_MAX_BYTES)) ?? {}; // a literal `null` body is a shape failure, not a crash
    const token = cleanToken(body.token);
    const chatId = cleanChatId(body.chatId);
    if (!token || !chatId) return sendJson(res, 400, { error: 'invalid request' });
    // Anti-oracle: no Telegram call, and ONE uniform 404 for every failure
    // cause — this endpoint can never confirm a stolen token's validity.
    const row = subStore.findSubscriber(token, chatId);
    if (!row) return sendJson(res, 404, { error: 'not found' });
    sendJson(res, 200, { planIds: row.planIds }); // planIds ONLY — never the token, never chat metadata
  }

  async function handleUpdate(req, res, ip) {
    if (rateLimited(res, `update-ip:${ip}`, RATE_BUDGETS.updateIp)) return;
    const body = (await readJsonBody(req, bodyTimeoutMs, SUB_BODY_MAX_BYTES)) ?? {}; // a literal `null` body is a shape failure, not a crash
    const token = cleanToken(body.token);
    const chatId = cleanChatId(body.chatId);
    const planIds = cleanPlanIds(body.planIds); // n ≥ 1 — the client turns 0 into delete
    if (!token || !chatId || !planIds) return sendJson(res, 400, { error: 'invalid request' });
    const index = snapshotPlanIndex();
    if (!index) return sendJson(res, 503, { error: 'warming up' });
    if (unknownPlanId(planIds, index)) return sendJson(res, 400, { error: 'unknown plan id' });
    const row = subStore.findSubscriber(token, chatId);
    if (!row) return sendJson(res, 404, { error: 'not found' }); // uniform (anti-oracle)

    // The 🔄 receipt is the gate, not best-effort: it sends FIRST with the new
    // list; only a Telegram ok persists the replacement (§B3 argued pins).
    const cardPlans = [...index.values()].filter((p) => planIds.includes(p.id));
    const sent = await notifier.sendCard({ token, chatId, text: buildReceiptCard({ plans: cardPlans, updated: true }) });
    if (!sent.ok) {
      if (sent.reason) return sendJson(res, 422, { reason: sent.reason }); // nothing changed
      return sendJson(res, 502, { error: 'telegram unreachable' });
    }
    subStore.updateSubscriber(row.id, { token, planIds }); // replace + re-encrypt + re-enable
    sendJson(res, 200, { ok: true, plans: planIds });
  }

  async function handleDelete(req, res, ip) {
    if (rateLimited(res, `delete-ip:${ip}`, RATE_BUDGETS.deleteIp)) return;
    const body = (await readJsonBody(req, bodyTimeoutMs, SUB_BODY_MAX_BYTES)) ?? {}; // a literal `null` body is a shape failure, not a crash
    const token = cleanToken(body.token);
    const chatId = cleanChatId(body.chatId);
    if (!token || !chatId) return sendJson(res, 400, { error: 'invalid request' });
    const row = subStore.findSubscriber(token, chatId);
    if (!row) return sendJson(res, 404, { error: 'not found' }); // uniform; client renders GONE anyway
    subStore.deleteSubscriber(row.id); // pending digests cascade (ON DELETE CASCADE)
    sendJson(res, 200, { ok: true }); // silent — no Telegram send (orchestrator default)
  }

  // The D8 mutating-route allowlist: /api/push (above) + these five POSTs.
  const SUB_HANDLERS = new Map([
    ['/api/subscribe', handleSubscribe],
    ['/api/chatid', handleChatId],
    ['/api/subscription/lookup', handleLookup],
    ['/api/subscription/update', handleUpdate],
    ['/api/subscription/delete', handleDelete],
  ]);

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
      if (SUB_HANDLERS.has(pathname)) {
        if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST');
        if (!subStore) return sendJson(res, 503, { error: 'subscriptions not configured' });
        return await SUB_HANDLERS.get(pathname)(req, res, clientIp(req));
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
        if (!subStore) {
          // Exactly one boot warn; the key VALUE is never logged.
          logger?.warn?.(
            tokenKey == null || tokenKey === ''
              ? '[board] TOKEN_KEY not configured — subscription routes answer 503 (board keeps serving)'
              : '[board] TOKEN_KEY malformed (need 64 hex chars) — subscription routes answer 503 (board keeps serving)',
          );
        } else {
          notifier.dispatch(); // boot re-drain: unsent digest rows younger than the TTL (§B2)
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
    limiter.stop();
    if (notifier) await notifier.stop(); // clears the window timer; in-flight sends settle ≤ the abort
    if (subStore) subStore.close();
    await writeChain; // let an in-flight mirror write settle before we return
  }

  return {
    start,
    stop,
    address: () => server.address(),
    // Idle-await test seam (§Q0 ②, the scheduler/publisher whenIdle precedent):
    // resolves once no digest window is armed and no dispatch is in flight.
    whenSubsIdle: () => (notifier ? notifier.whenIdle() : Promise.resolve()),
  };
}

// ---- CLI entry (container: `node /app/server.js`) ----------------------------
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createBoardServer({
    port: Number(process.env.PORT) || DEFAULT_PORT,
    host: process.env.HOST || DEFAULT_HOST,
    token: process.env.PUSH_TOKEN,
    snapshotFile: process.env.SNAPSHOT_FILE || '/data/snapshot.json',
    tokenKey: process.env.TOKEN_KEY,
    subDbFile: process.env.SUB_DB_FILE || '/data/board.db',
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
