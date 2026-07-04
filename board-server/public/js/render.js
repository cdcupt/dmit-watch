// Pure JSON→HTML builders for the public board (TECH §9 render contract) plus
// the one paint function board.js calls per new snapshot. The board is a pure
// projection of the pushed snapshot — it re-derives nothing about stock; a
// field that is absent renders nothing (never a placeholder). DOM-free at
// import time so every builder is unit-testable in plain Node (no jsdom).

import { esc, fmtDur } from './util.js';

// Freshness ladder thresholds (DESIGN §5 / PRD G3). freshTier lives here with
// its thresholds so tests hit the exact constants the page ships.
export const AGING_MS = 120_000; // fresh → aging
export const STALE_MS = 300_000; // aging → stale (banner + dim)

/** Freshness tier from a data age: fresh ≤ 2 min < aging ≤ 5 min < stale. */
export function freshTier(ageMs) {
  if (ageMs > STALE_MS) return 'stale';
  if (ageMs > AGING_MS) return 'aging';
  return 'fresh';
}

// Public status collapse (PRD D5): "unknown" — and any value we don't
// recognize — renders as the ONE neutral grey "Checking…" state. The page
// never shows an alarming or raw status to a stranger.
const pubStatus = (s) => (s === 'in' || s === 'out' ? s : 'checking');

/** Only http(s) deep links are ever interpolated into an anchor. */
const safeHref = (url) => (/^https?:\/\//i.test(String(url ?? '')) ? String(url) : null);

// Empty/first-deploy copy — exported so the skeleton (index.html) and tests
// stay on the same locked strings.
export const COPY = Object.freeze({
  warming: 'The board is warming up — waiting for the first snapshot from the watcher.',
  noneIn: 'Nothing in stock right now — the board refreshes about every minute.',
  allIn: 'All watched plans are in stock right now.',
});

// ---------- plan card (three public variants) ----------
// ctx is the pre-escaped context line ("🇭🇰 Hong Kong · AMD EPYC 7003 Series")
// carried only by IN cards lifted out of their DC group; wall cards pass null.
// `now` is the server-corrected clock so since-ages can't drift with the visitor.
export function cardHTML(plan, ctx, now) {
  const st = pubStatus(plan.status);
  const pill =
    st === 'in'
      ? '<span class="instockpill">In Stock</span>'
      : st === 'out'
        ? '<span class="oos">Out of Stock</span>'
        : '<span class="unk">Checking…</span>';
  const pop = plan.popular ? '<span class="popular">Popular</span>' : '';
  const ctxLine = ctx ? `<div class="ctxline">${ctx}</div>` : '';
  const num = String(plan.price ?? '').replace(/^\$/, '');
  // specs render ONLY when the snapshot carries a real non-empty value —
  // no "read at runtime" placeholder (standing rule; absent today).
  const specs = plan.specs
    ? `<div class="specs"><span aria-hidden="true">▤</span> ${esc(plan.specs)}</div>`
    : '';

  // Footer: IN gets Buy + honest in-stock age; OUT gets a quiet muted line only
  // when outSinceMs is present (render-if-present) — otherwise no footer at all
  // (the shorter card is the hierarchy). CHECKING never has a footer.
  let foot = '';
  if (st === 'in') {
    const href = safeHref(plan.deepLink);
    const buy = href
      ? `<a class="buy" href="${esc(href)}" target="_blank" rel="noopener">Buy now ▸</a>`
      : '';
    const since =
      plan.inSinceMs != null ? `<span class="since">in stock · ${fmtDur(now - plan.inSinceMs)}</span>` : '';
    if (buy || since) foot = `<div class="pfoot">${buy}${since}</div>`;
  } else if (st === 'out' && plan.outSinceMs != null) {
    foot = `<div class="pfoot"><span class="since out">out of stock · ${fmtDur(now - plan.outSinceMs)}</span></div>`;
  }

  return `<article class="pcard s-${st}" data-id="${esc(plan.id)}">
    <div class="pstatus">${pill}</div>
    <div class="phead"><span class="pname">${esc(plan.name)}</span>${pop}</div>
    ${ctxLine}
    <div class="price"><span class="cur">$</span><span class="num">${esc(num)}</span><span class="unit">USD</span><span class="per">/${esc(plan.period ?? 'mo')}</span></div>
    ${specs}${foot}
  </article>`;
}

// ---------- provider badge (data-driven, DESIGN §3) ----------
// whmcs anywhere in the DC → qq.pw · WHMCS; otherwise the DMIT default
// (defensive fallback when the provider field is absent).
export function dcBadge(dc) {
  const whmcs = (dc.generations ?? []).some((g) => g.provider === 'whmcs');
  return whmcs ? 'qq.pw · WHMCS' : 'DMIT · Premium';
}

// ---------- generation group (waiting wall only) ----------
// IN plans are lifted to the hero, so a gen with zero non-IN plans is omitted
// entirely; the enclosing DC bar stays behind as the anchor landmark.
export function genGroupHTML(gen, now) {
  const waiting = (gen.plans ?? []).filter((p) => pubStatus(p.status) !== 'in');
  if (!waiting.length) return '';
  const chip = /EPYC/i.test(gen.cpu ?? '')
    ? 'AMD<br>EPYC'
    : esc(String(gen.label ?? '').toUpperCase());
  const series = gen.cpu ? `<div class="gen-series">${esc(gen.cpu)}</div>` : '';
  return `<div class="gen-group">
    <div class="gen-card"><span class="epyc" aria-hidden="true">${chip}</span><div><div class="gen-code">${esc(gen.label)}</div>${series}</div><span class="gen-count">${waiting.length} plans</span></div>
    <div class="grid">${waiting.map((p) => cardHTML(p, null, now)).join('')}</div></div>`;
}

// ---------- datacenter section ----------
export function dcGroupHTML(dc, now) {
  const plans = (dc.generations ?? []).flatMap((g) => g.plans ?? []);
  const inCount = plans.filter((p) => pubStatus(p.status) === 'in').length;
  const allOut = plans.length > 0 && plans.every((p) => pubStatus(p.status) === 'out');
  const cnt = `${plans.length} watched${inCount ? ` · ${inCount} in stock ↑` : allOut ? ' · all out' : ''}`;
  const gens = (dc.generations ?? []).map((g) => genGroupHTML(g, now)).join('');
  return `<section class="dc-group" id="dc-${esc(dc.loc)}" aria-label="${esc(dc.city)}">
    <div class="dc-bar"><div class="dc-card"><span class="flag" aria-hidden="true">${esc(dc.flag)}</span><div><div class="dc-city">${esc(dc.city)}</div><div class="dc-country">${esc(dc.country)}</div></div></div>
    <span class="rp-badge">${esc(dcBadge(dc))}</span><span class="dc-count">${cnt}</span></div>${gens}</section>`;
}

// ---------- IN-STOCK-NOW hero (snapshot encounter order, no sorting) ----------
export function inStockCards(state, now) {
  const cards = [];
  for (const dc of state.datacenters ?? [])
    for (const g of dc.generations ?? [])
      for (const p of g.plans ?? [])
        if (pubStatus(p.status) === 'in')
          cards.push(cardHTML(p, [`${esc(dc.flag)} ${esc(dc.city)}`, esc(g.cpu ?? '')].filter(Boolean).join(' · '), now));
  return cards;
}

// ---------- jump chips + stats strip ----------
export function jumpChipsHTML(datacenters) {
  return (datacenters ?? [])
    .map((dc) => `<a class="jchip" href="#dc-${esc(dc.loc)}">${esc(dc.flag)} ${esc(dc.code ?? String(dc.loc).toUpperCase())}</a>`)
    .join('');
}

// Counts are used verbatim — the server is the single counter; the breakdown
// is per-location ONLY (byGen is operator detail the board never shows).
export function statsModel(counts) {
  const c = counts ?? {};
  const inN = c.in ?? 0;
  const waiting = c.waiting ?? 0;
  return {
    in: inN,
    waiting,
    total: c.total ?? 0,
    heroClass: `stat-hero ${inN > 0 ? 'in1' : 'in0'}`,
    breakdown: Object.entries(c.byLoc ?? {})
      .map(([k, v]) => `${k.toUpperCase()} ${v}`)
      .join(' · '),
    inBadge: `${inN} plan${inN === 1 ? '' : 's'} · buy while they last`,
    waitBadge: `${waiting} plans · grouped by datacenter`,
  };
}

// ---------- the one paint per new snapshot ----------
// DOM access happens only here, at call time. state:null = warming up (locked
// contract): the dashed empty block replaces the board, nothing else renders.
export function paint(state, { now = Date.now() } = {}) {
  const q = (s) => document.querySelector(s);
  const warming = state == null;
  q('#warming').hidden = !warming;
  q('#board').hidden = warming;
  if (warming) return;

  const m = statsModel(state.counts);
  q('#stIn').textContent = m.in;
  q('#stWait').textContent = m.waiting;
  q('#stTotal').textContent = m.total;
  q('#stInWrap').className = m.heroClass;
  q('#breakdown').textContent = m.breakdown;
  q('#inBadge').textContent = m.inBadge;
  q('#waitBadge').textContent = m.waitBadge;
  q('#jumpNav').innerHTML = jumpChipsHTML(state.datacenters);

  const inCards = inStockCards(state, now);
  q('#instockGrid').innerHTML = inCards.join('');
  q('#instockEmpty').style.display = inCards.length ? 'none' : '';

  // Everything-in-stock collapses the wall to its empty note (DESIGN §4).
  const wall = m.waiting > 0 ? (state.datacenters ?? []).map((dc) => dcGroupHTML(dc, now)).join('') : '';
  q('#waitingGroups').innerHTML = wall;
  q('#waitingEmpty').style.display = m.waiting > 0 ? 'none' : '';
}
