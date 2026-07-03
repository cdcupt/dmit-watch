// Scheduler / runtime wiring (TECH §07). The watcher already owns the per-family
// jittered cadence (~60s default, ±10%; see src/config.js resolveCadenceSec),
// exponential backoff on Cloudflare 403 / read errors,
// and the heartbeat tick (src/watcher.js). This layer is the FAN-OUT spine: it
// subscribes to the watcher's edge/blind events and routes them to Telegram and
// to a panel broadcast hook (wired by the SSE slice later), then drives the
// lifecycle (start/stop). Keeping the wiring here keeps each piece small and lets
// tests dry-run the loop with a fake watcher + a mocked Telegram send.
//
// Telegram policy: alert on a confirmed OUT→IN restock edge, and on an ESCALATED
// blind state (blind for longer than blindEscalateSec — the watcher sets
// escalate:true on the event). A short blind spell stays panel-only, but a
// persistent one means stock detection has been dark for hours and the operator
// must check by hand (the 2026-07-03 HKG+TYO restock sat panel-only for ~2 days).
// IN→OUT re-arms are state-only (panel history), never a phone buzz (TECH §06).

const NOOP = () => {};

/**
 * @param {object} opts
 * @param {object} opts.watcher    a watcher (src/watcher.js) — must expose
 *   on/off, start, stop and emit 'edge'|'rearm'|'blind'|'blind:cleared'|'family'|'cycle'|'error'
 * @param {object} opts.notifier   a Telegram notifier (src/telegram.js) with notifyEdge
 * @param {object} [opts.store]    store facade — used to stamp heartbeat uptime at start
 * @param {(event:string, payload:object) => void} [opts.broadcast] panel hook (Slice 4); default no-op
 * @param {() => number} [opts.now]
 * @param {object} [opts.logger]
 */
export function createScheduler({
  watcher,
  notifier,
  store,
  broadcast = NOOP,
  now = () => Date.now(),
  logger = console,
} = {}) {
  if (!watcher) throw new Error('createScheduler: watcher is required');
  if (!notifier) throw new Error('createScheduler: notifier is required');

  // Track in-flight async notifications so callers/tests can await a quiet point.
  const pending = new Set();
  function track(p) {
    pending.add(p);
    Promise.resolve(p).finally(() => pending.delete(p));
    return p;
  }
  /** Resolve once every in-flight notify settles (used by the smoke + tests). */
  async function whenIdle() {
    while (pending.size) await Promise.allSettled([...pending]);
  }

  // ---- event handlers ------------------------------------------------------
  function onEdge(ev) {
    const { plan, family, deepLink } = ev;
    logger?.log?.(`[scheduler] EDGE ${plan?.id} OUT→IN — alerting`);
    broadcast('edge', ev);
    track(notifier.notifyEdge({ plan, family, deepLink }));
  }

  function onRearm(ev) {
    logger?.log?.(`[scheduler] re-arm ${ev.plan?.id} IN→OUT (no telegram)`);
    broadcast('rearm', ev); // panel history only; never a phone alert
  }

  function onBlind(ev) {
    // Fresh blind → panel-only (noise). Escalated blind (persisted past
    // blindEscalateSec) → Telegram too: hours of paused detection can be hiding
    // a restock, and only a human can recover it.
    if (ev.escalate) {
      logger?.warn?.(`[scheduler] BLIND ${ev.family?.key}: ${ev.reasons?.join(', ')} (persistent — escalating to telegram)`);
      track(notifier.notifyBlind({ family: ev.family, reasons: ev.reasons, sinceMs: ev.sinceMs }));
    } else {
      logger?.warn?.(`[scheduler] BLIND ${ev.family?.key}: ${ev.reasons?.join(', ')} (panel-only, no telegram)`);
    }
    broadcast('blind', ev);
  }

  function onBlindCleared(ev) {
    logger?.log?.(`[scheduler] blind cleared ${ev.family?.key}`);
    broadcast('blind:cleared', ev); // recovery is visible on the panel; no buzz
  }

  function onFamily(summary) {
    broadcast('family', summary);
  }

  function onCycle(ev) {
    broadcast('cycle', ev);
  }

  function onError(ev) {
    logger?.error?.(`[scheduler] watcher error (${ev.family?.key ?? '?'}): ${ev.error?.message ?? ev.error}`);
    broadcast('error', { family: ev.family, error: String(ev.error?.message ?? ev.error) });
  }

  const wiring = [
    ['edge', onEdge],
    ['rearm', onRearm],
    ['blind', onBlind],
    ['blind:cleared', onBlindCleared],
    ['family', onFamily],
    ['cycle', onCycle],
    ['error', onError],
  ];

  let started = false;

  function start() {
    if (started) return;
    started = true;
    for (const [name, fn] of wiring) watcher.on(name, fn);
    // Stamp uptime so the panel's "running since" is anchored at process start.
    try {
      store?.touchHeartbeat?.({ tickTs: now(), chromeSession: 'STARTING' });
    } catch (err) {
      logger?.warn?.(`[scheduler] heartbeat init failed: ${err.message}`);
    }
    watcher.start();
    logger?.log?.('[scheduler] started — restock edges → telegram + panel; blind → panel only');
  }

  async function stop() {
    if (!started) return;
    started = false;
    for (const [name, fn] of wiring) watcher.off?.(name, fn);
    await watcher.stop?.();
    await whenIdle(); // let any in-flight alert finish writing its log row
    logger?.log?.('[scheduler] stopped');
  }

  return { start, stop, whenIdle, watcher, notifier };
}
