// PURE projection layer (TECH §09–§10 data contract). Turns the watchlist
// (display/order truth) + the SQLite store (live status/freshness truth) into the
// JSON the panel renders: /api/state, /api/health, /api/history, plus the small
// per-plan + per-transition deltas the SSE bridge pushes.
//
// No I/O of its own beyond reading the passed-in store facade — every function is
// deterministic given (watchlist, store, now), so it is unit-testable against a
// :memory: store. The panel is a pure projection of these shapes; it never
// re-derives stock or edge logic (that boundary keeps the on-panel alarm and the
// Telegram alert provably in lockstep).

import { familyUrl } from './chrome.js';

// Store keeps the binary edge basis (last_known) plus a richer DISPLAY status; the
// panel speaks lowercase. UNKNOWN/CHECKING never decide a section (only in vs out).
const STATUS_MAP = Object.freeze({ OUT: 'out', IN: 'in', UNKNOWN: 'unknown', CHECKING: 'checking' });
const toClientStatus = (s) => STATUS_MAP[String(s ?? '').toUpperCase()] ?? 'unknown';

// A heartbeat older than this means the loop is not ticking → watcher "down".
const RUNNING_STALE_MS = 5 * 60 * 1000;

/** Human "in stock for X" duration from seconds (null when unknown). */
export function durationText(seconds) {
  if (seconds == null) return null;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `in stock for ${s}s`;
  return `in stock for ${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Project one watchlist plan + its store row into the /api/state plan shape. */
function planView(plan, row, family, settings, alarmed) {
  const status = row ? toClientStatus(row.status) : 'out';
  return {
    id: plan.id,
    name: plan.name,
    size: plan.size,
    price: plan.price,
    period: plan.period ?? 'mo',
    popular: !!plan.popular,
    status,
    lastCheckMs: row?.last_checked ?? null,
    inSinceMs: status === 'in' ? (row?.last_change ?? null) : null,
    // Mirrors inSinceMs for the public board's "out of stock · 3d 4h" line.
    // Seeded-OUT plans that never transitioned have last_change null → null
    // (render-if-present: the board shows nothing).
    outSinceMs: status === 'out' ? (row?.last_change ?? null) : null,
    alarm: alarmed?.has?.(plan.id) === true && status === 'in',
    deepLink: plan.deepLink || familyUrl(settings, family),
  };
}

/** Derive the header watcher lamp ({status, uptimeMs, lastTickMs, chrome}). */
export function watcherView(store, now = Date.now()) {
  const hb = store.getHeartbeat?.() ?? null;
  const fams = store.allFamilyHealth?.() ?? [];
  const lastTickMs = hb?.tick_ts ?? null;
  const uptimeMs = hb?.uptime_started ? Math.max(0, now - hb.uptime_started) : null;
  const anyBackoff = fams.some((f) => (f.backoff_level ?? 0) > 0);
  const challenged = fams.some((f) => f.last_outcome === '403');
  const down = !lastTickMs || now - lastTickMs > RUNNING_STALE_MS;
  return {
    status: down ? 'down' : anyBackoff ? 'degraded' : 'running',
    uptimeMs,
    lastTickMs,
    chrome: challenged ? 'challenged' : down ? 'down' : 'cleared',
  };
}

function plansByFamilyMap(plans) {
  const m = new Map();
  for (const p of plans) {
    if (!m.has(p.family)) m.set(p.family, []);
    m.get(p.family).push(p);
  }
  return m;
}

/**
 * Full /api/state snapshot: datacenters → generations → instance-scale plans in
 * fixed config order, each plan's live status + freshness, and the counts strip.
 * Driven by the WATCHLIST (so a removed family disappears immediately), joined to
 * the store for status — stale store rows for removed plans are simply ignored.
 */
export function buildState({ watchlist, store, alarmed = new Set(), now = Date.now() }) {
  const settings = watchlist.settings ?? {};
  const families = watchlist.families ?? [];
  const plans = watchlist.plans ?? [];
  const byFamily = plansByFamilyMap(plans);

  const order = [];
  const byLocDc = new Map();
  const byLoc = {};
  const byGen = {};
  let inCount = 0;

  for (const fam of families) {
    if (!byLocDc.has(fam.loc)) {
      order.push(fam.loc);
      byLocDc.set(fam.loc, {
        loc: fam.loc,
        code: fam.locCode ?? String(fam.loc).toUpperCase(),
        city: fam.city ?? fam.loc,
        country: fam.country ?? '',
        flag: fam.flag ?? '',
        generations: [],
      });
    }
    const famPlans = (byFamily.get(fam.key) ?? []).map((p) => {
      const v = planView(p, store.getPlan(p.id), fam, settings, alarmed);
      if (v.status === 'in') inCount += 1;
      byLoc[p.loc] = (byLoc[p.loc] ?? 0) + 1;
      byGen[p.gen] = (byGen[p.gen] ?? 0) + 1;
      return v;
    });
    byLocDc.get(fam.loc).generations.push({
      key: fam.key,
      gen: fam.gen,
      label: fam.genLabel ?? String(fam.gen).toUpperCase(),
      cpu: fam.cpu ?? '',
      // Family provider surfaced per generation so the public board's DC badge
      // is data-driven (whmcs → "qq.pw · WHMCS", default dmit → "DMIT · Premium").
      provider: fam.provider ?? 'dmit',
      plans: famPlans,
    });
  }

  const total = plans.length;
  return {
    generatedAt: now,
    watcher: watcherView(store, now),
    counts: { total, in: inCount, waiting: total - inCount, byLoc, byGen },
    datacenters: order.map((loc) => byLocDc.get(loc)),
  };
}

/** One plan delta (SSE `plan` event) — null if the id is not in the watchlist. */
export function planDeltaFor(planId, { watchlist, store, alarmed = new Set() }) {
  const plan = (watchlist.plans ?? []).find((p) => p.id === planId);
  if (!plan) return null;
  const family = (watchlist.families ?? []).find((f) => f.key === plan.family);
  return planView(plan, store.getPlan(planId), family, watchlist.settings ?? {}, alarmed);
}

function historyRow(row, planName) {
  const to = String(row.to_status).toLowerCase();
  return {
    name: planName,
    to,
    t: row.ts,
    dur: to === 'in' ? 'alert fired' : durationText(row.duration_in_stock),
  };
}

/** The newest transition for a plan, as a History row (SSE `history` event). */
export function latestHistoryRow(planId, { watchlist, store }) {
  const rows = store.transitionsForPlan?.(planId, 1) ?? [];
  if (!rows.length) return null;
  const name = (watchlist.plans ?? []).find((p) => p.id === planId)?.name ?? planId;
  return historyRow(rows[0], name);
}

/** /api/history — reverse-chronological OUT⇄IN transitions (?limit, ?before). */
export function buildHistory({ watchlist, store, limit = 50, before = null, now = Date.now() }) {
  const window = before ? Math.max(limit * 4, 200) : limit;
  const rows = store.recentTransitions?.(window) ?? [];
  const nameById = new Map((watchlist.plans ?? []).map((p) => [p.id, p.name]));
  const filtered = (before ? rows.filter((r) => r.ts < before) : rows).slice(0, limit);
  return {
    generatedAt: now,
    transitions: filtered.map((r) => historyRow(r, nameById.get(r.plan_id) ?? r.plan_id)),
  };
}

/** /api/health — Chrome session, scheduler tick, per-family poll, Telegram log. */
export function buildHealth({ watchlist, store, now = Date.now(), telegramLimit = 25 }) {
  const families = watchlist.families ?? [];
  const plans = watchlist.plans ?? [];
  const healthByKey = new Map((store.allFamilyHealth?.() ?? []).map((h) => [h.family, h]));
  const countByFamily = plans.reduce((acc, p) => ((acc[p.family] = (acc[p.family] ?? 0) + 1), acc), {});

  const familyRows = families.map((f) => {
    const h = healthByKey.get(f.key);
    return {
      key: f.key,
      label: f.label ?? f.key,
      sub: [f.city, f.cpu].filter(Boolean).join(' · '),
      count: countByFamily[f.key] ?? 0,
      backoff: h?.backoff_level ?? 0,
      lastPollMs: h?.last_poll_ts ?? null,
      outcome: h?.last_outcome ?? null,
      chromeState: h?.chrome_state ?? null,
      blind: !!h?.blind,
      blindReasons: h?.blind_reasons ? String(h.blind_reasons).split(',') : [],
      blindSinceMs: h?.blind_since ?? null,
    };
  });

  const nameById = new Map(plans.map((p) => [p.id, p.name]));
  const telegram = (store.recentTelegram?.(telegramLimit) ?? []).map((r) => ({
    name: r.plan_id ? (nameById.get(r.plan_id) ?? r.plan_id) : 'Watcher blind alert',
    ok: r.sent_ok === 1,
    ts: r.ts,
    error: r.last_error ?? null,
  }));

  const hb = store.getHeartbeat?.() ?? null;
  const wv = watcherView(store, now);
  return {
    generatedAt: now,
    chrome: {
      state: hb?.chrome_session ?? 'unknown',
      detail: 'real Chrome · CDP-attach · persistent profile',
    },
    scheduler: { lastTickMs: hb?.tick_ts ?? null, status: wv.status },
    families: familyRows,
    telegram,
  };
}
