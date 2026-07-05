// Telegram sender for the public board's subscriptions (round-2 TECH §B2/§B4):
// pure HTML card builders (locked copy — DESIGN §6), the 75 s digest window,
// the crash-safe queue dispatcher, and the one-shot transport helpers the
// subscription routes use for confirmation/receipt sends and chat-id discovery.
//
// api.telegram.org is the ONLY external host this module (or any board-server
// file) may contact (D8) — every outbound call rides the injected fetch seam.
// REDACTION EVERYWHERE: tokens ride in the URL path to Telegram, so no log
// line, response body, or digest_queue.last_error may ever carry a URL or a
// raw Telegram description — failures are mapped to enum reasons at this
// boundary and the description text is discarded (§B4).
//
// Injectable side effects (the src/telegram.js discipline): fetch, now, sleep,
// windowMs (tests run ~15 ms — the publisher debounceMs precedent), logger.

const TELEGRAM_API = 'https://api.telegram.org';
const DEFAULT_WINDOW_MS = 75_000; // D4, orchestrator-pinned
const DEFAULT_SEND_TIMEOUT_MS = 10_000; // per-attempt abort (§B4)
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_TTL_MS = 30 * 60_000; // an unsent row older than this expires, never sends
const DISABLE_AFTER_EXHAUSTED = 5; // consecutive exhausted dispatches → disabled=1
const MAX_PLAN_LINES = 25; // beyond: "+{k} more — see the board" (< 4096 chars)

const MANAGE_LINE = 'manage: vps-stock.daichenlab.com/?manage=1';
const DIGEST_LAG_NOTE = 'data can lag ~5 min';
const RECEIPT_FOOT = 'checks run ~every 5 min · a plan re-alerts only after it goes out of stock again';

/** Escape the three HTML-significant characters — & FIRST, then < and > (§B4). */
export function escHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// The render.js safeHref rule, ported (provenance: public/js/render.js:27):
// only http(s) URLs are ever interpolated into an <a href>.
export const safeHref = (url) => (/^https?:\/\//i.test(String(url ?? '')) ? String(url) : null);

/** Shared 25-line truncation: bullet lines capped, "+{k} more — see the board" appended. */
function truncateLines(lines) {
  if (lines.length <= MAX_PLAN_LINES) return lines;
  const kept = lines.slice(0, MAX_PLAN_LINES);
  kept.push(`+${lines.length - MAX_PLAN_LINES} more — see the board`);
  return kept;
}

/**
 * Digest card (DESIGN §6 verbatim). `plans` come pre-ordered in snapshot
 * encounter order; "as of" is the EDGE time (windowOpenedAt), never the send
 * time — honest even if the send retried for minutes.
 * @param {{plans: Array<{name,price,period,city,deepLink}>, edgeTime: number}} arg
 */
export function buildDigestCard({ plans, edgeTime }) {
  const n = plans.length;
  const header = `<b>🟢 Restock — ${n} of your plans ${n === 1 ? 'is' : 'are'} IN STOCK</b>`;
  const bullets = truncateLines(
    plans.map((p) => {
      const line = `• <b>${escHtml(p.name)}</b> — ${escHtml(p.price)}/${escHtml(p.period)} — ${escHtml(p.city)}`;
      const href = safeHref(p.deepLink);
      return href ? `${line} · <a href="${escHtml(href)}">Buy now</a>` : line;
    }),
  );
  const hhmm = new Date(edgeTime).toISOString().slice(11, 16);
  return [header, '', ...bullets, '', `as of ${hhmm} UTC · ${DIGEST_LAG_NOTE}`, MANAGE_LINE].join('\n');
}

/**
 * Confirmation / 🔄 update receipt card (DESIGN §6). Plan bullets carry
 * name — city only (a receipt, not a pitch: no prices, no buy links).
 * @param {{plans: Array<{name,city}>, updated?: boolean}} arg
 */
export function buildReceiptCard({ plans, updated = false }) {
  const header = updated ? '<b>🔄 Subscription updated</b>' : '<b>✅ Subscribed — VPS Stock Watch</b>';
  const bullets = truncateLines(plans.map((p) => `• ${escHtml(p.name)} — ${escHtml(p.city)}`));
  return [
    header,
    '',
    `You'll get ONE digest card here when any of your ${plans.length} plans restock:`,
    '',
    ...bullets,
    '',
    RECEIPT_FOOT,
    MANAGE_LINE,
  ].join('\n');
}

/**
 * Race a (possibly injected, signal-ignoring) fetch against a hard timeout.
 * The losing promise's eventual rejection is swallowed so a reaped hang can
 * never surface as an unhandledRejection (DSP-U9).
 */
function withTimeout(promise, ms) {
  let timer;
  const guarded = Promise.resolve(promise);
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
    timer.unref?.();
  });
  return Promise.race([guarded, gate]).finally(() => {
    clearTimeout(timer);
    guarded.catch(() => {});
  });
}

/**
 * POST one sendMessage; resolve {ok, status, description}. Never throws.
 * Copied/adapted from src/telegram.js:119-138 (provenance: deliberate DRY
 * exception — deployment isolation, §B0) with the AbortSignal.timeout the
 * round-1 module lacked, HTML parse_mode, and disabled link previews.
 * A thrown fetch error's message can embed the tokened URL — it is REDACTED
 * to the 'timeout' / 'network' enums here, at the boundary.
 */
export async function postOnce({
  fetch,
  apiBase = TELEGRAM_API,
  token,
  chatId,
  text,
  timeoutMs = DEFAULT_SEND_TIMEOUT_MS,
}) {
  const endpoint = `${apiBase.replace(/\/$/, '')}/bot${token}/sendMessage`;
  try {
    const resp = await withTimeout(
      fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId, // STRING end-to-end — Telegram chat ids are int64 (§B3)
          text,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timeoutMs,
    );
    let body = null;
    try {
      body = await resp.json();
    } catch {
      /* non-JSON body (rare); treat as failure with the HTTP status */
    }
    const ok = !!resp.ok && body?.ok === true;
    const description = ok ? null : body?.description || `http ${resp.status}`;
    return { ok, status: resp.status ?? 0, description };
  } catch (err) {
    return { ok: false, status: 0, description: err?.message === 'timeout' ? 'timeout' : 'network' };
  }
}

/**
 * Map a failed sendMessage to the route-facing enum (§B3): Telegram 401/404 →
 * 'token_rejected'; 403 or 400 "chat not found" → 'chat_not_found'; anything
 * else (timeout / network / 5xx / unexpected) → null, which callers answer 502.
 * The raw description is consumed HERE and never travels further.
 */
export function mapSendFailure({ status, description }) {
  if (status === 401 || status === 404) return 'token_rejected';
  if (status === 403) return 'chat_not_found';
  if (status === 400 && /chat not found/i.test(description ?? '')) return 'chat_not_found';
  return null;
}

/**
 * Create the notifier: digest window + queue dispatcher + one-shot sends.
 * @param {object} opts
 * @param {object} opts.store          openSubStore facade
 * @param {() => Map|null} opts.getPlanIndex  id → {name,price,period,city,deepLink}, snapshot encounter order
 * @param {Function} [opts.fetch]      injectable fetch — the ONLY egress seam
 * @param {() => number} [opts.now]
 * @param {(ms:number)=>Promise<void>} [opts.sleep]
 * @param {number} [opts.windowMs]     digest window (default 75 000; tests ~15)
 * @param {number} [opts.sendTimeoutMs]
 * @param {object} [opts.logger]
 * @param {string} [opts.apiBase]
 */
export function createNotifier({
  store,
  getPlanIndex,
  fetch = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  windowMs = DEFAULT_WINDOW_MS,
  sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  concurrency = DEFAULT_CONCURRENCY,
  ttlMs = DEFAULT_TTL_MS,
  logger = console,
  apiBase = TELEGRAM_API,
} = {}) {
  if (!store) throw new Error('createNotifier: store is required');
  if (typeof getPlanIndex !== 'function') throw new Error('createNotifier: getPlanIndex is required');

  const pending = new Set(); // fired planIds awaiting window close (dedup by planId)
  let windowTimer = null;
  let windowOpenedAt = null; // = the FIRST edge's time; becomes the card's "as of"
  let dispatchPromise = null;
  let rerunAfterDrain = false;
  let stopped = false;

  // Copied from src/telegram.js:113-116 (provenance: same DRY exception).
  function backoffMs(attempt) {
    const base = baseDelayMs * Math.pow(2, attempt - 1);
    return base + Math.floor(Math.random() * baseDelayMs); // small jitter
  }

  // ---- 75 s digest window (§B2) ---------------------------------------------
  /** An armed OUT→IN fired: join the pending Set; the first edge opens the window. */
  function noteFire(planId, at = now()) {
    if (stopped) return;
    pending.add(planId);
    if (windowTimer == null) {
      windowOpenedAt = at;
      windowTimer = setTimeout(closeWindow, windowMs);
      windowTimer.unref?.(); // never holds the process open (WIN-U8)
    }
  }

  /** A pending plan observed OUT again mid-window: retract — never announced. */
  function retract(planId) {
    pending.delete(planId);
  }

  function closeWindow() {
    windowTimer = null;
    const fired = [...pending];
    pending.clear();
    const edgeTime = windowOpenedAt;
    windowOpenedAt = null;
    if (fired.length === 0) return; // everything retracted — nothing to close
    try {
      store.closeDigestWindow({ firedPlanIds: fired, edgeTime, now: now() });
    } catch (err) {
      // Rollback left the plans armed — the next push re-fires them (level-
      // triggered self-heal). The message is a store/SQL error, never a token.
      logger?.warn?.(`[board] digest window close failed: ${err.message}`);
      return;
    }
    dispatch(); // async — a push response never waits on Telegram
  }

  // ---- queue dispatcher (§B2: ALL Telegram I/O lives here) --------------------
  async function dispatchRow(row) {
    if (row.disabled) return; // disabled rows receive nothing
    if (row.created_at < now() - ttlMs) {
      store.markQueueExpired(row.id, row.attempts); // a stale restock "alert" is worse than none
      return;
    }
    let token;
    try {
      token = store.decryptToken(row);
    } catch {
      store.disableSubscriber(row.subscriber_id);
      store.markQueueError(row.id, { attempts: row.attempts, lastError: 'decrypt-failed' });
      logger?.warn?.(`[board] digest row ${row.id}: token decrypt failed (key rotated?) — subscriber disabled`);
      return;
    }
    // Card is built from the LATEST snapshot: vanished plan ids drop their
    // line; all gone → mark sent, no card at all (DSP-U8).
    const index = getPlanIndex();
    const ids = new Set(JSON.parse(row.plan_ids));
    const plans = index ? [...index.values()].filter((p) => ids.has(p.id)) : [];
    if (plans.length === 0) {
      store.markQueueSent(row.id, now(), row.attempts);
      return;
    }
    const text = buildDigestCard({ plans, edgeTime: row.created_at });
    let attempts = 0;
    let lastError = null;
    while (attempts < maxAttempts) {
      attempts += 1;
      const r = await postOnce({ fetch, apiBase, token, chatId: row.chat_id, text, timeoutMs: sendTimeoutMs });
      if (r.ok) {
        store.markQueueSent(row.id, now(), attempts);
        store.recordSendOk(row.subscriber_id, now());
        return;
      }
      if (r.status === 401 || r.status === 403) {
        // Revoked token / blocked bot — retrying is pointless (R6).
        store.disableSubscriber(row.subscriber_id);
        store.markQueueError(row.id, { attempts, lastError: r.status === 401 ? 'unauthorized' : 'forbidden' });
        return;
      }
      lastError = r.status > 0 ? `http ${r.status}` : r.description; // 'timeout' | 'network' | 'http NNN' — enums only
      if (attempts < maxAttempts) await sleep(backoffMs(attempts));
    }
    store.markQueueError(row.id, { attempts, lastError });
    const failCount = store.recordSendFail(row.subscriber_id);
    if (failCount >= DISABLE_AFTER_EXHAUSTED) store.disableSubscriber(row.subscriber_id);
  }

  async function runDrain() {
    const rows = store.unsentQueue();
    let i = 0;
    const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (i < rows.length && !stopped) {
        const row = rows[i++];
        try {
          await dispatchRow(row);
        } catch (err) {
          logger?.warn?.(`[board] digest row ${row.id}: dispatch failed (${err.message})`);
        }
      }
    });
    await Promise.all(workers);
  }

  /** Drain every unsent queue row (boot re-drain + window close). Never rejects. */
  function dispatch() {
    if (dispatchPromise) {
      rerunAfterDrain = true; // rows enqueued mid-drain get a follow-up pass
      return dispatchPromise;
    }
    dispatchPromise = runDrain()
      .catch((err) => logger?.warn?.(`[board] digest dispatch failed: ${err.message}`))
      .finally(() => {
        dispatchPromise = null;
        if (rerunAfterDrain && !stopped) {
          rerunAfterDrain = false;
          dispatch();
        }
      });
    return dispatchPromise;
  }

  /** Resolve once no window is armed and no dispatch is running (tests + stop). */
  async function whenIdle() {
    while (windowTimer || dispatchPromise) {
      if (dispatchPromise) await dispatchPromise;
      else await new Promise((r) => setTimeout(r, 2));
    }
  }

  async function stop() {
    stopped = true;
    if (windowTimer) {
      clearTimeout(windowTimer);
      windowTimer = null;
    }
    if (dispatchPromise) await dispatchPromise; // in-flight rows settle ≤ sendTimeoutMs
  }

  // ---- one-shot sends for the routes (sync sends are single-attempt, §B4) ----
  /** Confirmation/receipt send. → {ok:true} | {ok:false, reason:enum|null(→502)}. */
  async function sendCard({ token, chatId, text }) {
    const r = await postOnce({ fetch, apiBase, token, chatId, text, timeoutMs: sendTimeoutMs });
    if (r.ok) return { ok: true };
    return { ok: false, reason: mapSendFailure(r) };
  }

  /**
   * Chat-id discovery via getUpdates. The chat id is extracted from the RAW
   * response text (never JSON.parse'd into a JS number): Telegram chat ids are
   * int64 and would corrupt past 2^53 (§B3). Newest message wins.
   * → {ok:true, chatId:string} | {ok:false, reason:'token_rejected'|'no_chat'|null(→502)}
   */
  async function discoverChatId(token) {
    const endpoint = `${apiBase.replace(/\/$/, '')}/bot${token}/getUpdates`;
    let resp;
    try {
      resp = await withTimeout(fetch(endpoint, { signal: AbortSignal.timeout(sendTimeoutMs) }), sendTimeoutMs);
    } catch {
      return { ok: false, reason: null }; // timeout / network → 502 (message redacted)
    }
    if (resp.status === 401 || resp.status === 404) return { ok: false, reason: 'token_rejected' };
    if (resp.status === 409) return { ok: false, reason: 'no_chat' }; // webhook set — can't be auto-read
    let raw = '';
    try {
      raw = await resp.text();
    } catch {
      return { ok: false, reason: null };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* unparseable body → treated as unreachable below */
    }
    if (!resp.ok || parsed?.ok !== true) return { ok: false, reason: null };
    const matches = [...raw.matchAll(/"chat"\s*:\s*\{[^{}]*?"id"\s*:\s*(-?\d+)/g)];
    if (matches.length === 0) return { ok: false, reason: 'no_chat' };
    return { ok: true, chatId: matches[matches.length - 1][1] };
  }

  return {
    noteFire,
    retract,
    dispatch,
    whenIdle,
    stop,
    sendCard,
    discoverChatId,
    pendingCount: () => pending.size,
    endpointRedacted: `${apiBase}/bot<redacted>/sendMessage`, // the src/telegram.js log discipline
  };
}
