// The watcher: drives the dedicated Chrome through the 6 cart.php combos, runs
// the PURE detector (src/detect.js) over each render, persists status +
// transitions, and emits events on OUT→IN edges and blind-watcher alerts.
//
// The Chrome/CDP layer is INJECTABLE (the `pageSource` option): production uses
// createCdpPageSource (src/chrome.js); tests + the smoke inject a fake that
// returns fixture text. The watcher never touches Playwright directly.
//
// Events (EventEmitter):
//   'edge'   {plan, family, deepLink, transition}  — confirmed OUT→IN, fire once
//   'rearm'  {plan, family, durationInStock}        — confirmed IN→OUT
//   'blind'  {family, reasons, plans}               — ⚠️ watcher may be blind (re-emits while it persists, throttled by blindRenotifySec)
//   'blind:cleared' {family}                        — recovered
//   'family' {family, outcome, detection, edges}    — one family poll finished
//   'cycle'  {ts, families}                          — one full pass finished
//   'error'  {family, error}                         — unexpected poll failure

import { EventEmitter } from 'node:events';
import { classifyFamily, computeEdges, assessBlindness, STOCK } from './detect.js';
import { createCdpPageSource, familyUrl } from './chrome.js';
import { nextDelayMs as computeNextDelayMs } from './backoff.js';
import { resolveCadenceSec } from './config.js';

const DEFAULT_BLIND_CYCLES = 3;
const DEFAULT_CONTROL_K = 3;
const DEFAULT_BLIND_RENOTIFY_SEC = 3600; // re-remind, hourly, while a family stays blind

function groupPlansByFamily(plans) {
  const map = new Map();
  for (const p of plans) {
    if (!map.has(p.family)) map.set(p.family, []);
    map.get(p.family).push(p);
  }
  return map;
}

/**
 * @param {object} opts
 * @param {object} opts.store        the SQLite store facade (src/store.js)
 * @param {object} opts.watchlist    parsed config/watchlist.json
 * @param {object} [opts.pageSource] injectable { readFamily, close }; defaults to CDP
 * @param {() => number} [opts.now]  clock (epoch ms) — injectable for tests
 * @param {object} [opts.logger]
 */
export function createWatcher({ store, watchlist, pageSource, now = () => Date.now(), rng = Math.random, logger = console } = {}) {
  if (!store) throw new Error('createWatcher: store is required');
  if (!watchlist) throw new Error('createWatcher: watchlist is required');

  const settings = watchlist.settings ?? {};
  // Resolve the poll cadence ONCE: env override → single number / legacy band →
  // default, already floor-clamped into a [minSec, maxSec] ±10% jitter band that
  // backoff.js consumes directly. (Default 60s; see src/config.js + README.)
  const cadenceSec = resolveCadenceSec(settings, { logger });
  const families = watchlist.families ?? [];
  const familyByKey = new Map(families.map((f) => [f.key, f]));
  const plansByFamily = groupPlansByFamily(watchlist.plans ?? []);

  const blindCycles = settings.blindCycles ?? DEFAULT_BLIND_CYCLES;
  const controlGroupMinK = settings.controlGroupMinK ?? DEFAULT_CONTROL_K;
  const cooldownMs = (settings.cooldownSec ?? 0) * 1000;
  const blindRenotifyMs = (settings.blindRenotifySec ?? DEFAULT_BLIND_RENOTIFY_SEC) * 1000;

  const source =
    pageSource ??
    createCdpPageSource({
      // 127.0.0.1 (not localhost) to match Chrome's --remote-allow-origins exactly.
      endpoint: settings.chromeDebugPort ? `http://127.0.0.1:${settings.chromeDebugPort}` : undefined,
      settings,
      logger,
    });

  // ---- per-family streak / health state (in-memory; persisted summaries go to DB) ----
  const unknownStreak = new Map(); // planId -> consecutive UNKNOWN cycles
  const markerMissStreak = new Map(); // familyKey -> consecutive markers-missing cycles
  const blockedStreak = new Map(); // familyKey -> consecutive CF/login-blocked cycles
  const blindState = new Map(); // familyKey -> bool (currently blind)
  const lastBlindEmit = new Map(); // familyKey -> ts of the last 'blind' emit (throttles re-notify)
  const backoffLevel = new Map(); // familyKey -> int
  const timers = new Map(); // familyKey -> Timeout
  let running = false;

  // Global poll lock: a promise-chain mutex so only ONE read/navigation runs at a
  // time. The CDP page source (src/chrome.js) drives a single shared Playwright
  // Page; two family timers firing together would otherwise issue concurrent
  // goto()s on it — Playwright rejects the second, inflating UNKNOWN streaks and
  // tripping spurious blind alerts. Serializing reads here protects that shared
  // page regardless of which page source is injected.
  let readChain = Promise.resolve();
  function serializedRead(family) {
    const run = readChain.then(
      () => source.readFamily(family),
      () => source.readFamily(family), // a prior read's rejection must not stall the chain
    );
    readChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  const emitter = new EventEmitter();

  function buildUnreadableDetection(family, plans, read) {
    const reason = read.status === 403 ? 'blocked' : read.error ? 'read-error' : 'markers-missing';
    return {
      markersPresent: false,
      blocked: read.status === 403,
      loginWall: false,
      countMatch: false,
      namesFound: 0,
      expectedCount: family?.planCount ?? plans.length,
      controlOutCount: 0,
      results: plans.map((p) => ({ id: p.id, name: p.name, stock: STOCK.UNKNOWN, reason })),
    };
  }

  function bump(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
    return map.get(key);
  }

  function updateStreaks(family, plans, detection) {
    // per-plan UNKNOWN streaks
    for (const r of detection.results) {
      if (r.stock === STOCK.UNKNOWN) unknownStreak.set(r.id, (unknownStreak.get(r.id) ?? 0) + 1);
      else unknownStreak.set(r.id, 0);
    }
    // page-level streaks
    if (detection.blocked || detection.loginWall) bump(blockedStreak, family.key);
    else blockedStreak.set(family.key, 0);
    if (!detection.markersPresent && !detection.blocked && !detection.loginWall) {
      bump(markerMissStreak, family.key);
    } else if (detection.markersPresent) {
      markerMissStreak.set(family.key, 0);
    }
  }

  function streaksForFamily(plans) {
    const out = {};
    for (const p of plans) out[p.id] = unknownStreak.get(p.id) ?? 0;
    return out;
  }

  function persistEdges(family, plans, detection, edges, ts) {
    for (const e of edges.perPlan) {
      store.setPlanState(e.id, {
        status: e.stock,
        lastKnown: e.newLastKnown,
        armed: e.newArmed,
        lastChecked: ts,
        lastChange: e.transition ? ts : undefined,
      });
      if (e.transition) {
        store.recordTransition({
          planId: e.id,
          from: e.transition.from,
          to: e.transition.to,
          ts,
          durationInStock: e.transition.duration,
        });
      }
    }
  }

  function persistHealth(family, detection, read, ts) {
    const outcome = read.ok ? 'ok' : read.status === 403 ? '403' : 'err';
    const level = read.ok ? 0 : bump(backoffLevel, family.key);
    if (read.ok) backoffLevel.set(family.key, 0);
    store.setFamilyHealth(family.key, {
      lastPollTs: ts,
      backoffLevel: level,
      lastOutcome: outcome,
      chromeState: read.chromeState ?? (read.ok ? 'UP' : 'DOWN'),
    });
    return outcome;
  }

  function emitEdges(family, plans, edges) {
    const byId = new Map(plans.map((p) => [p.id, p]));
    for (const e of edges.fired) {
      const plan = byId.get(e.id);
      emitter.emit('edge', {
        plan,
        family,
        deepLink: plan?.deepLink ?? familyUrl(settings, family),
        transition: e.transition,
      });
    }
    for (const e of edges.rearmed) {
      emitter.emit('rearm', {
        plan: byId.get(e.id),
        family,
        durationInStock: e.transition?.duration ?? null,
      });
    }
  }

  function evaluateBlind(family, plans, ts) {
    const assessment = assessBlindness({
      blindCycles,
      unknownStreaks: streaksForFamily(plans),
      markerMissingStreak: markerMissStreak.get(family.key) ?? 0,
      blockedStreak: blockedStreak.get(family.key) ?? 0,
    });
    const was = blindState.get(family.key) ?? false;
    if (assessment.blind) {
      // Emit on entry, then re-emit on a throttled interval so a persistent
      // Cloudflare block keeps reminding the operator — but never every cycle.
      const last = lastBlindEmit.get(family.key);
      const due = last == null || ts - last >= blindRenotifyMs;
      if (!was || due) {
        blindState.set(family.key, true);
        lastBlindEmit.set(family.key, ts);
        emitter.emit('blind', { family, reasons: assessment.reasons, plans: assessment.plans });
      }
    } else if (was) {
      blindState.set(family.key, false);
      lastBlindEmit.delete(family.key); // recovery: clear so the next blind re-emits immediately
      emitter.emit('blind:cleared', { family });
    }
    return assessment;
  }

  /**
   * Poll a single family: read → detect → edge → persist → emit. Returns a
   * summary; never throws (failures become UNKNOWN + an 'error'/'family' event).
   */
  async function pollFamily(familyKey) {
    const family = familyByKey.get(familyKey);
    if (!family) throw new Error(`unknown family "${familyKey}"`);
    const plans = plansByFamily.get(familyKey) ?? [];
    const ts = now();

    let read;
    try {
      read = await serializedRead(family); // global mutex: never two navigations at once
    } catch (err) {
      read = { ok: false, status: 0, pageText: '', error: err.message, chromeState: 'DOWN' };
    }

    const detection = read.ok
      ? classifyFamily({ pageText: read.pageText, family, plans, controlGroupMinK })
      : buildUnreadableDetection(family, plans, read);

    const storedById = {};
    for (const p of plans) storedById[p.id] = store.getPlan(p.id);
    const edges = computeEdges(detection.results, storedById, { now: ts, cooldownMs });

    try {
      persistEdges(family, plans, detection, edges, ts);
      const outcome = persistHealth(family, detection, read, ts);
      updateStreaks(family, plans, detection);
      const blind = evaluateBlind(family, plans, ts);
      emitEdges(family, plans, edges);

      store.touchHeartbeat({ tickTs: ts, chromeSession: read.chromeState ?? (read.ok ? 'UP' : 'DOWN') });

      const summary = {
        family: familyKey,
        ts,
        outcome,
        statuses: Object.fromEntries(detection.results.map((r) => [r.id, r.stock])),
        fired: edges.fired.map((e) => e.id),
        rearmed: edges.rearmed.map((e) => e.id),
        blind: blind.blind,
        blindReasons: blind.reasons,
        markersPresent: detection.markersPresent,
      };
      emitter.emit('family', { ...summary, detection, edges });
      return summary;
    } catch (err) {
      logger?.error?.(`[watcher] poll ${familyKey} failed: ${err.message}`);
      emitter.emit('error', { family, error: err });
      return { family: familyKey, ts, outcome: 'err', error: err.message };
    }
  }

  /** Poll every family once, staggered sequentially. Returns per-family summaries. */
  async function pollAllOnce() {
    const summaries = [];
    for (const f of families) {
      summaries.push(await pollFamily(f.key));
    }
    emitter.emit('cycle', { ts: now(), families: summaries });
    return summaries;
  }

  // ---- scheduling (per-family jittered timer + exponential backoff) ----
  function nextDelayMs(familyKey) {
    return computeNextDelayMs({
      cadenceSec,
      backoffFactor: settings.backoffFactor ?? 2,
      backoffCapSec: settings.backoffCapSec ?? 900,
      level: backoffLevel.get(familyKey) ?? 0,
      rng,
    });
  }

  function scheduleFamily(familyKey, delayMs) {
    if (!running) return;
    const t = setTimeout(async () => {
      if (!running) return;
      try {
        await pollFamily(familyKey);
      } catch (err) {
        logger?.error?.(`[watcher] scheduled poll ${familyKey}: ${err.message}`);
      }
      scheduleFamily(familyKey, nextDelayMs(familyKey));
    }, delayMs);
    if (typeof t.unref === 'function') t.unref();
    timers.set(familyKey, t);
  }

  /** Start the per-family scheduling loops (offset so the 6 families never hit at once). */
  function start() {
    if (running) return;
    running = true;
    const [min] = cadenceSec;
    const spreadMs = ((min * 1000) / Math.max(1, families.length)) | 0;
    families.forEach((f, i) => scheduleFamily(f.key, i * spreadMs + rng() * 1000));
  }

  /** Stop scheduling and close the page source. */
  async function stop() {
    running = false;
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    try {
      await source.close?.();
    } catch {
      /* ignore */
    }
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
    emitter,
    pollFamily,
    pollAllOnce,
    start,
    stop,
    // exposed for diagnostics / tests
    _state: { unknownStreak, markerMissStreak, blockedStreak, blindState, lastBlindEmit, backoffLevel },
  };
}
