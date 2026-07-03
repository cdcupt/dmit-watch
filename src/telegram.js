// Telegram alerting (TECH §06). Best-effort, logged, never blocks the cycle.
//
// One message per confirmed OUT→IN edge, carrying everything Erik needs to buy
// by hand: plan name, datacenter + CPU/generation, price, a one-tap cart.php
// deep link, and a detected-at timestamp. A distinct "⚠️ watcher may be blind"
// message covers the safety net (a quietly broken reader / lost session).
//
// Everything that touches the network is injectable:
//   - `fetch`   so tests assert the built payload without hitting the real bot
//   - `secrets` so tests never read ~/.dmit-watch/config
//   - `sleep`   so retry/backoff is instant under test
// The secret VALUES are never logged; the bot token never appears in any log line.

import { loadSecrets } from './config.js';

const TELEGRAM_API = 'https://api.telegram.org';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;

/** Local wall-clock HH:MM:SS for a "detected …" stamp (matches the spec sample). */
function clockHMS(ts) {
  return new Date(ts).toTimeString().slice(0, 8);
}

/**
 * Build the OUT→IN alert text (pure). Mirrors TECH §06 exactly:
 *   🟢 IN STOCK — LAX.AN4.Pro.MEDIUM
 *   Los Angeles · EPYC 9004 (AN4) · $239.90/mo
 *   Buy ▸ https://www.dmit.io/cart.php?...
 *   detected 14:32:07
 * @param {{ plan:object, family:object, deepLink:string, now?:number }} arg
 */
export function buildEdgeMessage({ plan, family, deepLink, now = Date.now() }) {
  const name = plan?.name ?? plan?.id ?? 'unknown plan';
  const where = family?.city ?? family?.locCode ?? family?.loc ?? '';
  const cpu = family?.cpu ? `${family.cpu} ` : '';
  const gen = family?.genLabel ?? family?.gen ?? '';
  const genPart = gen ? `${cpu}(${gen})` : cpu.trim();
  const price = plan?.price ? `${plan.price}/${plan?.period ?? 'mo'}` : 'price unavailable';
  const specLine = [where, genPart, price].filter(Boolean).join(' · ');
  return [
    `🟢 IN STOCK — ${name}`,
    specLine,
    `Buy ▸ ${deepLink}`,
    `detected ${clockHMS(now)}`,
  ].join('\n');
}

/** Human "for Xh Ym" from a blind-since timestamp (null → empty string). */
function blindForText(sinceMs, now) {
  if (sinceMs == null) return '';
  const mins = Math.max(0, Math.round((now - sinceMs) / 60_000));
  const h = Math.floor(mins / 60);
  return h > 0 ? ` for ${h}h ${mins % 60}m` : ` for ${mins}m`;
}

/**
 * Build the blind-watcher / session-attention alert text (pure). This is the
 * ONLY alert that fires without a confirmed IN — a broken reader must never
 * silently hide a restock (TECH §04 safety net, §02 re-clear path). Sent only
 * once blindness has persisted past blindEscalateSec, so it always means
 * "check the cart page by hand NOW — a restock may be hiding behind this".
 * @param {{ family:object, reasons?:string[], sinceMs?:number|null, now?:number }} arg
 */
export function buildBlindMessage({ family, reasons = [], sinceMs = null, now = Date.now() }) {
  const label = family?.label ?? family?.key ?? 'a watch group';
  const needsReclear = reasons.some((r) => r === 'persistent-block' || r === 'login-wall');
  const hint = needsReclear
    ? 'Bring the dedicated Chrome to the front to re-clear Cloudflare / re-login.'
    : 'The cart page stopped parsing cleanly — check the dedicated Chrome session AND the cart page by hand (a mass restock can look exactly like this).';
  return [
    `⚠️ Watcher blind${blindForText(sinceMs, now)} — ${label}`,
    `Reasons: ${reasons.length ? reasons.join(', ') : 'unknown'}`,
    `${hint} Stock detection is paused for this group until it recovers (no in-stock alert can fire while blind).`,
    `checked ${clockHMS(now)}`,
  ].join('\n');
}

/**
 * Create the Telegram notifier.
 * @param {object} opts
 * @param {{botToken?:string, chatId?:string}} [opts.secrets] defaults to loadSecrets()
 * @param {object}   [opts.store]    store facade; logs each alert to telegram_log
 * @param {Function} [opts.fetch]    injectable fetch (defaults to global)
 * @param {() => number} [opts.now]
 * @param {object}   [opts.logger]
 * @param {number}   [opts.maxAttempts]
 * @param {number}   [opts.baseDelayMs]
 * @param {string}   [opts.apiBase]
 * @param {(ms:number)=>Promise<void>} [opts.sleep]
 */
export function createTelegramNotifier({
  secrets,
  store,
  fetch = globalThis.fetch,
  now = () => Date.now(),
  logger = console,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  apiBase = TELEGRAM_API,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const creds = secrets ?? loadSecrets();
  const { botToken, chatId } = creds;
  if (!botToken || !chatId) {
    throw new Error('createTelegramNotifier: botToken and chatId are required');
  }
  if (typeof fetch !== 'function') {
    throw new Error('createTelegramNotifier: no fetch available (inject one)');
  }
  const endpoint = `${apiBase.replace(/\/$/, '')}/bot${botToken}/sendMessage`;

  function backoffMs(attempt) {
    const base = baseDelayMs * Math.pow(2, attempt - 1);
    return base + Math.floor(Math.random() * baseDelayMs); // small jitter
  }

  /** POST one sendMessage; resolve {ok, status, description}. Never throws. */
  async function postOnce(text) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
      });
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
      return { ok: false, status: 0, description: err.message };
    }
  }

  /**
   * Send one alert with retry + exponential backoff; record exactly one
   * telegram_log row (final state). Best-effort: resolves a result, never throws.
   * @returns {Promise<{ok:boolean, attempts:number, lastError:string|null, text:string}>}
   */
  async function send(text, { planId = null, deepLink = null, kind = 'alert' } = {}) {
    const ts = now();
    let attempts = 0;
    let lastError = null;

    while (attempts < maxAttempts) {
      attempts += 1;
      const r = await postOnce(text);
      if (r.ok) {
        lastError = null;
        logger?.log?.(`[telegram] ${kind} sent (attempt ${attempts})`);
        record({ planId, ts, deepLink, message: text, sentOk: true, attempts, lastError: null, sentTs: now() });
        return { ok: true, attempts, lastError: null, text };
      }
      lastError = r.description;
      logger?.warn?.(`[telegram] ${kind} attempt ${attempts}/${maxAttempts} failed: ${lastError}`);
      if (attempts < maxAttempts) await sleep(backoffMs(attempts));
    }

    logger?.error?.(`[telegram] ${kind} exhausted after ${attempts} attempts: ${lastError}`);
    record({ planId, ts, deepLink, message: text, sentOk: false, attempts, lastError, sentTs: null });
    return { ok: false, attempts, lastError, text };
  }

  function record(row) {
    if (!store?.logTelegram) return;
    try {
      store.logTelegram(row);
    } catch (err) {
      logger?.warn?.(`[telegram] log write failed: ${err.message}`);
    }
  }

  /** Alert a confirmed OUT→IN edge ({plan, family, deepLink}). */
  function notifyEdge({ plan, family, deepLink }) {
    const text = buildEdgeMessage({ plan, family, deepLink, now: now() });
    return send(text, { planId: plan?.id ?? null, deepLink, kind: 'edge' });
  }

  /** Alert the blind-watcher / session-attention condition ({family, reasons, sinceMs}). */
  function notifyBlind({ family, reasons, sinceMs = null }) {
    const text = buildBlindMessage({ family, reasons, sinceMs, now: now() });
    return send(text, { planId: null, deepLink: null, kind: 'blind' });
  }

  return { notifyEdge, notifyBlind, send, endpointRedacted: `${apiBase}/bot<redacted>/sendMessage` };
}
