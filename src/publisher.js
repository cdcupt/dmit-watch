// Public-board push publisher (public-stock-page TECH §3). Subscribes to the
// watcher's 'family' events through the composed broadcast in src/index.js and
// fire-and-forgets privacy-filtered snapshots to the board server:
//
//   'family' → trailing debounce (coalesces bursts) → in-flight? skip →
//   build the payload FRESH from the store → POST /api/push (Bearer, 10 s abort)
//
// Everything is best-effort: a push failure can never break watching or
// alerting, nothing is queued or retried (the next family poll, ≤ one cadence
// away, IS the retry), and the debounce timer is unref'd so an armed timer
// never holds the process open. Disabled (config null) it is a callable no-op.
//
// Injectable like telegram.js: `fetch`, `now`, `logger` — plus `debounceMs` so
// tests debounce in ~15 ms instead of the real 3 s. The token appears only in
// the Authorization header; no log line ever carries it (host at most).

import { buildState } from './state.js';

const DEFAULT_DEBOUNCE_MS = 3_000; // trailing window that coalesces event bursts
const DEFAULT_TIMEOUT_MS = 10_000; // a hung socket must not wedge the in-flight flag
const FAILURE_LOG_INTERVAL_MS = 5 * 60_000; // ≤ 1 failure line per 5 min while down

/** Host-only label for log lines — never the full URL's path, never the token. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable url)';
  }
}

/**
 * Create the push publisher.
 * @param {object} opts
 * @param {{url:string, token:string}|null} opts.config loadPushConfig() output; null → no-op
 * @param {() => object} opts.getWatchlist LIVE watchlist getter (panel server's), never a boot copy
 * @param {object}   opts.store store facade for buildState()
 * @param {number}   [opts.cadenceSec] resolved target cadence in seconds (index.js passes the
 *   midpoint of the resolveCadenceSec band); when set, the envelope carries it so the board
 *   can derive freshness thresholds honestly (subscriptions TECH §B6/D7). Omitted → the
 *   round-1 envelope shape, byte-identical.
 * @param {() => number} [opts.now]
 * @param {Function} [opts.fetch]  injectable fetch (defaults to global)
 * @param {object}   [opts.logger]
 * @param {number}   [opts.debounceMs] trailing debounce (default 3000; tests pass ~1)
 * @param {number}   [opts.timeoutMs]  per-request abort (default 10000)
 * @returns {{enabled:boolean, onEvent:Function, stop:Function, whenIdle:Function, _state?:object}}
 */
export function createPublisher({
  config,
  getWatchlist,
  store,
  cadenceSec,
  now = () => Date.now(),
  fetch = globalThis.fetch,
  logger = console,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!config) {
    // Not configured — the public-repo default. Callable, does nothing, so the
    // composed broadcast in index.js is identical either way.
    return { enabled: false, onEvent() {}, async stop() {}, async whenIdle() {} };
  }
  if (typeof getWatchlist !== 'function') throw new Error('createPublisher: getWatchlist is required');
  if (!store) throw new Error('createPublisher: store is required');
  if (typeof fetch !== 'function') throw new Error('createPublisher: no fetch available (inject one)');

  const host = hostOf(config.url);
  const stopController = new AbortController(); // aborts an in-flight fetch on stop()

  let timer = null; // armed trailing-debounce timer (null when idle)
  let inFlight = false; // at most ONE outstanding request, ever
  let pendingSend = null; // the in-flight send promise (never rejects)
  let stopped = false;
  let failing = false; // true between first failure and the recovery line
  let lastFailureLogMs = -Infinity;

  // Counters exposed for tests (the telegram.js observability pattern).
  const _state = {
    sends: 0,
    okSends: 0,
    failedSends: 0,
    skippedInFlight: 0,
    suppressedFailureLogs: 0,
  };

  /**
   * Build the payload FRESH at send time (a skipped fire never leaves a stale
   * body behind). buildState's default-empty alarmed set → alarm:false on every
   * plan; the watcher key and per-plan lastCheckMs are operator internals and
   * are stripped before wrapping (DESIGN §8 privacy filter).
   *
   * Envelope: {v:1, pushedAt, cadenceSec, state}. v stays 1 — cadenceSec is an
   * OPTIONAL-field addition (§B6/D7, rolling-deploy safe): present only when the
   * option was passed as a positive finite number, otherwise the key is omitted
   * entirely so the round-1 shape stays byte-identical.
   */
  function buildPayload() {
    const state = buildState({ watchlist: getWatchlist(), store, alarmed: new Set(), now: now() });
    delete state.watcher; // uptime/Chrome/backoff lamp — stays on the watcher
    for (const dc of state.datacenters ?? []) {
      for (const gen of dc.generations ?? []) {
        for (const plan of gen.plans ?? []) delete plan.lastCheckMs; // poll timing is operator detail
      }
    }
    if (Number.isFinite(cadenceSec) && cadenceSec > 0) {
      return { v: 1, pushedAt: now(), cadenceSec, state };
    }
    return { v: 1, pushedAt: now(), state };
  }

  /** First failure logs immediately, then ≤ 1 line per 5 min; host only, never the token. */
  function logFailureThrottled(reason) {
    const t = now();
    if (!failing || t - lastFailureLogMs >= FAILURE_LOG_INTERVAL_MS) {
      logger?.warn?.(`[publisher] push failed: ${reason} — target ${host} (further failures logged at most every 5 min)`);
      lastFailureLogMs = t;
    } else {
      _state.suppressedFailureLogs += 1;
    }
    failing = true;
  }

  /** One send. Fully try/caught — this promise NEVER rejects (fire-and-forget). */
  async function send() {
    inFlight = true;
    _state.sends += 1;
    try {
      const body = JSON.stringify(buildPayload());
      // The abort is load-bearing, not cosmetic: without it a hung socket would
      // wedge the in-flight flag and silently stop all future pushes.
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), stopController.signal]);
      const resp = await fetch(config.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body,
        signal,
      });
      if (!resp?.ok) throw new Error(`http ${resp?.status ?? 0}`);
      _state.okSends += 1;
      if (failing) {
        failing = false;
        logger?.log?.(`[publisher] push recovered — ${host}`);
      }
    } catch (err) {
      _state.failedSends += 1;
      logFailureThrottled(err?.message ?? String(err));
    } finally {
      inFlight = false;
    }
  }

  /** Debounce timer fired: skip outright if a push is still awaiting its response. */
  function fire() {
    timer = null;
    if (stopped) return;
    if (inFlight) {
      // No queue, no retry loop — the next 'family' event (≤ ~60 s) re-arms
      // with strictly newer data; nothing is built on a skipped fire.
      _state.skippedInFlight += 1;
      return;
    }
    pendingSend = send().finally(() => {
      pendingSend = null;
    });
  }

  /** Synchronous timer arming only — reacts to 'family', ignores every other event. */
  function onEvent(event) {
    if (stopped || event !== 'family') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
    timer.unref?.(); // never holds the process open
  }

  /** Clear the timer + abort any in-flight fetch; resolves promptly (no await of a hung socket). */
  async function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    stopController.abort();
  }

  /** Resolve once no timer is armed and no push is in flight (tests + the e2e loop). */
  async function whenIdle() {
    while (timer || pendingSend) {
      if (pendingSend) await pendingSend;
      else await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  return { enabled: true, onEvent, stop, whenIdle, _state };
}
