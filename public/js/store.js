// Client-side mirror of /api/state. Holds the server's snapshot tree and applies
// SSE deltas IMMUTABLY (new objects, never in-place mutation) — the panel is a
// pure projection of this state and re-derives nothing about stock/edges.

let data = null; // last /api/state snapshot { generatedAt, watcher, counts, datacenters[] }
let history = []; // [{name,to,t,dur}]

export function setSnapshot(snap) {
  data = snap;
}
export function getData() {
  return data;
}
export function getWatcher() {
  return data?.watcher ?? null;
}

/** Merge a partial watcher update (header lamps) without touching plans. */
export function applyWatcher(patch) {
  if (!data) return;
  data = { ...data, watcher: { ...(data.watcher ?? {}), ...patch } };
}

/**
 * Replace one plan by id across the datacenter→generation tree, returning a new
 * tree (structural sharing for the untouched branches). Unknown ids are ignored
 * (e.g. a delta for a plan removed from the watchlist).
 */
export function applyPlan(delta) {
  if (!data || !delta?.id) return false;
  let hit = false;
  const datacenters = data.datacenters.map((dc) => {
    let dcHit = false;
    const generations = dc.generations.map((g) => {
      const idx = g.plans.findIndex((p) => p.id === delta.id);
      if (idx === -1) return g;
      dcHit = true;
      hit = true;
      const plans = g.plans.slice();
      plans[idx] = { ...plans[idx], ...delta };
      return { ...g, plans };
    });
    return dcHit ? { ...dc, generations } : dc;
  });
  if (hit) data = { ...data, datacenters };
  return hit;
}

/** Every plan flattened in render order. */
export function allPlans() {
  if (!data) return [];
  return data.datacenters.flatMap((dc) => dc.generations.flatMap((g) => g.plans));
}

/** Look up one plan by id from the current snapshot (null if unknown). */
export function planById(id) {
  if (!id) return null;
  return allPlans().find((p) => p.id === id) ?? null;
}

/**
 * Authoritative in-stock check used to gate the on-panel alarm: a plan is "IN"
 * ONLY when our own state confirms status:"in" (the on-screen analogue of the
 * watcher's never-false-IN invariant). An alert whose plan isn't confirmed IN
 * must not light the banner.
 */
export function isPlanIn(id) {
  const p = planById(id);
  return !!p && p.status === 'in';
}

/** Families derived from the tree (for the Watchlist tab). */
export function families() {
  if (!data) return [];
  return data.datacenters.flatMap((dc) =>
    dc.generations.map((g) => ({
      key: g.key,
      label: `${dc.code}·${g.label}`,
      sub: [dc.city, g.cpu].filter(Boolean).join(' · '),
      count: g.plans.length,
    })),
  );
}

/** Recompute the counts strip from current plan state (so deltas need not carry it). */
export function counts() {
  const plans = allPlans();
  const inCount = plans.filter((p) => p.status === 'in').length;
  const byLoc = {};
  const byGen = {};
  for (const dc of data?.datacenters ?? []) {
    for (const g of dc.generations) {
      byLoc[dc.loc] = (byLoc[dc.loc] ?? 0) + g.plans.length;
      byGen[g.gen] = (byGen[g.gen] ?? 0) + g.plans.length;
    }
  }
  return { total: plans.length, in: inCount, waiting: plans.length - inCount, byLoc, byGen };
}

export function setHistory(rows) {
  history = rows.slice();
}
export function prependHistory(row) {
  if (!row) return;
  history = [row, ...history].slice(0, 200);
}
export function getHistory() {
  return history;
}
