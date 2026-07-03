// PURE stock detection + edge logic for DMIT cart.php pages (TECH §04).
//
// Nothing here does I/O — no browser, no DB, no clock side effects. Every export
// takes plain data and returns plain data, so the whole policy is unit-testable
// against text fixtures. The watcher (src/watcher.js) is the only impure layer:
// it reads the page over CDP, then hands the text to these functions.
//
// Recon v3 truth (docs/pipeline/recon-premium.md): stock is keyed on the VISIBLE
// "Out of Stock" label, never a CSS selector or pid. A read/parse failure is
// UNKNOWN and is NEVER promoted to IN — a false in-stock alert is structurally
// impossible. The opposite danger (a quietly broken reader) is caught by the
// blind-watcher net below.

export const STOCK = Object.freeze({ OUT: 'OUT', IN: 'IN', UNKNOWN: 'UNKNOWN' });

// Per-card "this SKU is sold out" text. Matched case-insensitively against the
// card's own text segment only (NOT the page footer's "TOTAL DUE: Unavailable",
// which is page-level and would otherwise bleed into the last card).
const OUT_OF_STOCK_MARKERS = ['out of stock', 'sold out'];

// Structural anchors a real cart.php configurator render always contains. Their
// absence means we are not looking at the cart (CF interstitial, login wall,
// truncated/changed page) and the read is untrustworthy.
const CART_ANCHORS = ['total due today', 'instance scale', 'configure your'];
const CART_FOOTER_ANCHORS = ['total due today'];

// Cloudflare-challenge / login-wall fingerprints — the page is blocked, not the cart.
const BLOCK_MARKERS = [
  'just a moment',
  'checking your browser',
  'verify you are human',
  'verifying you are human',
  'enable javascript and cookies',
  'cf-browser-verification',
  'attention required',
];
const LOGIN_MARKERS = ['login to your account', 'sign in to continue', 'forgot your password'];

const PRICE_RE = /\$\s?\d[\d,]*\.?\d*/;

const lc = (s) => String(s ?? '').toLowerCase();
const hasAny = (hayLc, needles) => needles.some((n) => hayLc.includes(n));

/**
 * Page-level structure check for one family's cart.php render.
 * @returns {{ blocked:boolean, loginWall:boolean, anchorPresent:boolean,
 *   generationPresent:boolean, premiumPresent:boolean, namesFound:number,
 *   expectedCount:number, countMatch:boolean, markersPresent:boolean }}
 */
export function pageMarkers({ pageText, family, plans }) {
  const hay = lc(pageText);
  const blocked = hasAny(hay, BLOCK_MARKERS);
  const loginWall = hasAny(hay, LOGIN_MARKERS);
  const genToken = lc(family?.genLabel ?? family?.gen ?? '');
  const generationPresent = genToken ? hay.includes(genToken) : false;
  const premiumPresent = hay.includes('premium');
  const anchorPresent = hasAny(hay, CART_ANCHORS);
  const namesFound = plans.filter((p) => hay.includes(lc(p.name))).length;
  const expectedCount = family?.planCount ?? plans.length;
  const countMatch = namesFound === expectedCount;
  const markersPresent =
    !blocked && !loginWall && anchorPresent && generationPresent && premiumPresent && namesFound > 0;
  return {
    blocked,
    loginWall,
    anchorPresent,
    generationPresent,
    premiumPresent,
    namesFound,
    expectedCount,
    countMatch,
    markersPresent,
  };
}

/**
 * Slice out one plan's card text: from its name to the next plan name (or the
 * footer anchor). Case-insensitive search, original-case slice. Null if absent.
 */
export function cardSegment(pageText, name, boundaryNames) {
  const text = String(pageText ?? '');
  const hay = lc(text);
  const nameLc = lc(name);
  const start = hay.indexOf(nameLc);
  if (start === -1) return null;
  const after = start + nameLc.length;
  let end = text.length;
  const stops = [...boundaryNames.filter((n) => lc(n) !== nameLc), ...CART_FOOTER_ANCHORS];
  for (const stop of stops) {
    const i = hay.indexOf(lc(stop), after);
    if (i !== -1 && i < end) end = i;
  }
  return text.slice(start, end);
}

/**
 * Classify every plan in a family from the rendered page text.
 * Conservative by construction: only an explicit "Out of Stock" label yields
 * OUT; an orderable card is promoted to IN only when ALL sanity gates hold
 * (name+price parsed, expected plan-count rendered, ≥K control-group plans still
 * OUT this cycle); anything else is UNKNOWN.
 *
 * The control group is GLOBAL: `externalOutCount` carries fresh OUT labels the
 * watcher saw on OTHER families' pages, so a family-wide restock (zero local OUT
 * labels — exactly the 2026-07-03 HKG+TYO event) still clears the gate as long
 * as any family's sold-out wall proves the reader parses the current layout.
 *
 * @returns page markers spread + { controlOutCount, results: Array<{id,name,stock,reason}> }
 */
export function classifyFamily({
  pageText,
  family,
  plans,
  controlGroupMinK = 3,
  externalOutCount = 0,
}) {
  const markers = pageMarkers({ pageText, family, plans });

  // Page is not a trustworthy cart render -> every plan UNKNOWN, no edges.
  if (!markers.markersPresent) {
    const reason = markers.blocked
      ? 'blocked'
      : markers.loginWall
        ? 'login-wall'
        : 'markers-missing';
    return {
      ...markers,
      controlOutCount: externalOutCount,
      results: plans.map((p) => ({ id: p.id, name: p.name, stock: STOCK.UNKNOWN, reason })),
    };
  }

  const names = plans.map((p) => p.name);

  // Pass 1 — raw per-card signal.
  const raw = plans.map((p) => {
    const seg = cardSegment(pageText, p.name, names);
    if (seg == null) return { plan: p, kind: 'missing' };
    const segLc = lc(seg);
    if (hasAny(segLc, OUT_OF_STOCK_MARKERS)) return { plan: p, kind: 'out' };
    return { plan: p, kind: 'candidate', hasPrice: PRICE_RE.test(seg) };
  });

  // Control group = plans confirmed OUT this same cycle (+ any external OUTs).
  const outCount = raw.filter((r) => r.kind === 'out').length + externalOutCount;

  // Pass 2 — finalize. Candidates clear all gates or fall back to UNKNOWN.
  const results = raw.map((r) => {
    const { plan } = r;
    if (r.kind === 'out') {
      return { id: plan.id, name: plan.name, stock: STOCK.OUT, reason: 'out-of-stock-label' };
    }
    if (r.kind === 'missing') {
      return { id: plan.id, name: plan.name, stock: STOCK.UNKNOWN, reason: 'card-missing' };
    }
    const gates = {
      price: r.hasPrice,
      count: markers.countMatch,
      control: outCount >= controlGroupMinK,
    };
    if (gates.price && gates.count && gates.control) {
      return { id: plan.id, name: plan.name, stock: STOCK.IN, reason: 'orderable' };
    }
    const failed = Object.entries(gates)
      .filter(([, ok]) => !ok)
      .map(([k]) => k);
    return { id: plan.id, name: plan.name, stock: STOCK.UNKNOWN, reason: `gate-fail:${failed.join(',')}` };
  });

  return { ...markers, controlOutCount: outCount, results };
}

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

/**
 * Run the edge engine across a family's classification results.
 * @param results classifyFamily(...).results
 * @param storedById map planId -> stored plans row (or undefined)
 * @returns {{ perPlan, fired, rearmed }}
 */
export function computeEdges(results, storedById = {}, { now = Date.now(), cooldownMs = 0 } = {}) {
  const perPlan = results.map((r) => {
    const stored = storedById[r.id] ?? null;
    const edge = computePlanEdge({ stock: r.stock, stored, now, cooldownMs });
    return { id: r.id, name: r.name, reason: r.reason, ...edge };
  });
  return {
    perPlan,
    fired: perPlan.filter((e) => e.fire),
    rearmed: perPlan.filter((e) => e.rearm),
  };
}

/**
 * Blind-watcher net (TECH §04). The only alert that fires WITHOUT a confirmed
 * IN: a broken reader must never silently hide a restock. Pure — the watcher
 * owns the streak counters and passes them in.
 *
 * @param unknownStreaks map planId -> consecutive-UNKNOWN cycles
 * @param markerMissingStreak consecutive cycles the page's structure markers were absent
 * @param blockedStreak consecutive cycles the page was CF/login blocked
 * @returns {{ blind:boolean, reasons:string[], plans:string[] }}
 */
export function assessBlindness({
  blindCycles = 3,
  unknownStreaks = {},
  markerMissingStreak = 0,
  blockedStreak = 0,
} = {}) {
  const reasons = [];
  const offenders = Object.entries(unknownStreaks)
    .filter(([, n]) => n >= blindCycles)
    .map(([id]) => id);
  if (markerMissingStreak >= blindCycles) reasons.push('structure-markers-missing');
  if (blockedStreak >= blindCycles) reasons.push('persistent-block');
  if (offenders.length) reasons.push('persistent-unknown');
  return { blind: reasons.length > 0, reasons, plans: offenders };
}
