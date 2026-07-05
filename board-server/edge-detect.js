// PURE edge detection for the board-server's subscription pipeline (round-2
// TECH §B0/§B2). STOCK and computePlanEdge are a VERBATIM COPY of
// src/detect.js:14 and src/detect.js:181-250 — the watcher's proven edge
// engine, deliberately duplicated so the deployable unit stays self-contained
// (zero ../src imports; the http-body.js precedent at server.js:29-31). The
// parity test EDG-U1 proves the copy by behavior across the full matrix.
//
// wireToStock is board-server-only: it maps the push envelope's per-plan wire
// status ('in' | 'out' | anything else) onto STOCK. The cold-start fire-free
// seeding policy (absent plan_edges row → seed, never diff; 'unknown' seeds no
// row — a deliberate divergence from computePlanEdge's stored=null ⇒ armed OUT
// default) lives in sub-store.js observePlan, not here: this module stays pure.

// Copied from src/detect.js:14 (provenance: verbatim, deliberate DRY exception).
export const STOCK = Object.freeze({ OUT: 'OUT', IN: 'IN', UNKNOWN: 'UNKNOWN' });

/** Map a push-envelope wire status onto STOCK: 'in'→IN, 'out'→OUT, else UNKNOWN. */
export function wireToStock(status) {
  if (status === 'in') return STOCK.IN;
  if (status === 'out') return STOCK.OUT;
  return STOCK.UNKNOWN;
}

// Copied from src/detect.js:181-250 (provenance: verbatim, deliberate DRY
// exception — deployment isolation wins; see the module header).
/**
 * Edge engine for a single plan: compare a fresh classification against stored
 * state. Fires once on an armed OUT→IN; re-arms only on a confirmed IN→OUT.
 * UNKNOWN holds position — never an edge, never a re-arm.
 *
 * @param stored a plans row ({ last_known, armed, last_change }) or null
 * @returns {{ stock, prevKnown, fire, rearm, newLastKnown, newArmed, lastChange, transition }}
 */
export function computePlanEdge({ stock, stored, now = Date.now(), cooldownMs = 0 }) {
  const prevKnown = stored?.last_known === STOCK.IN ? STOCK.IN : STOCK.OUT;
  const armed = stored?.armed === undefined || stored?.armed === null ? true : !!stored.armed;
  const lastChange = stored?.last_change ?? null;

  if (stock === STOCK.UNKNOWN) {
    return {
      stock,
      prevKnown,
      fire: false,
      rearm: false,
      newLastKnown: prevKnown,
      newArmed: armed,
      lastChange,
      transition: null,
    };
  }

  if (stock === STOCK.OUT) {
    if (prevKnown === STOCK.IN) {
      const duration = lastChange != null ? Math.max(0, Math.round((now - lastChange) / 1000)) : null;
      return {
        stock,
        prevKnown,
        fire: false,
        rearm: true,
        newLastKnown: STOCK.OUT,
        newArmed: true,
        lastChange: now,
        transition: { from: STOCK.IN, to: STOCK.OUT, duration },
      };
    }
    return {
      stock,
      prevKnown,
      fire: false,
      rearm: false,
      newLastKnown: STOCK.OUT,
      newArmed: armed,
      lastChange,
      transition: null,
    };
  }

  // stock === IN
  if (prevKnown === STOCK.OUT && armed) {
    const cooled = cooldownMs > 0 && lastChange != null && now - lastChange < cooldownMs;
    return {
      stock,
      prevKnown,
      fire: !cooled, // cooldown suppresses the alert but the transition is still real
      rearm: false,
      newLastKnown: STOCK.IN,
      newArmed: false, // disarm so a SKU that stays IN does not re-alert every cycle
      lastChange: now,
      transition: { from: STOCK.OUT, to: STOCK.IN, duration: null },
    };
  }
  // already IN (or somehow disarmed-OUT) -> still in, no alert
  return {
    stock,
    prevKnown,
    fire: false,
    rearm: false,
    newLastKnown: STOCK.IN,
    newArmed: armed,
    lastChange,
    transition: null,
  };
}
