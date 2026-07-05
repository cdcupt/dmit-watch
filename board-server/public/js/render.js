// Pure JSON→HTML builders for the public board (TECH §9 render contract) plus
// the one paint function board.js calls per new snapshot. The board is a pure
// projection of the pushed snapshot — it re-derives nothing about stock; a
// field that is absent renders nothing (never a placeholder). DOM-free at
// import time so every builder is unit-testable in plain Node (no jsdom).

import { esc, fmtDur } from './util.js';

// Freshness ladder (round-2 TECH §fe-fresh / PRD D7): thresholds derive from
// the served cadence — aging strictly after 2× cadence, stale strictly after
// 4× — with the round-1 constants as the null-safe fallback for envelopes
// that don't carry cadenceSec yet (rolling deploy honesty).
export const AGING_MULT = 2; // fresh → aging at AGING_MULT × cadence
export const STALE_MULT = 4; // aging → stale at STALE_MULT × cadence
export const FALLBACK_AGING_MS = 120_000; // round-1 ladder, kept for old envelopes
export const FALLBACK_STALE_MS = 300_000;

/** Freshness tier from a data age and the served cadence (ms, nullable). */
export function freshTier(ageMs, cadenceMs) {
  const hasCad = Number.isFinite(cadenceMs) && cadenceMs > 0;
  const agingMs = hasCad ? AGING_MULT * cadenceMs : FALLBACK_AGING_MS;
  const staleMs = hasCad ? STALE_MULT * cadenceMs : FALLBACK_STALE_MS;
  if (ageMs > staleMs) return 'stale';
  if (ageMs > agingMs) return 'aging';
  return 'fresh';
}

/** Cadence copy forms, minute-rounded: long "5 minutes"/"minute", short "~5 min". */
export function fmtCadence(cadenceMs) {
  const ms = Number.isFinite(cadenceMs) && cadenceMs > 0 ? cadenceMs : 60_000;
  const min = Math.max(1, Math.round(ms / 60_000));
  return { long: min === 1 ? 'minute' : `${min} minutes`, short: `~${min} min` };
}

/**
 * Screen-reader tier strings derived from the SAME thresholds freshTier uses —
 * minutes are computed, never restated literals. Null cadence reproduces the
 * round-1 strings verbatim (2 / 5 minutes).
 */
export function tierMsgs(cadenceMs) {
  const hasCad = Number.isFinite(cadenceMs) && cadenceMs > 0;
  const min = (ms) => {
    const m = Math.max(1, Math.round(ms / 60_000));
    return `${m} minute${m === 1 ? '' : 's'}`;
  };
  const aging = min(hasCad ? AGING_MULT * cadenceMs : FALLBACK_AGING_MS);
  const stale = min(hasCad ? STALE_MULT * cadenceMs : FALLBACK_STALE_MS);
  return Object.freeze({
    fresh: `Board data is fresh — updated under ${aging} ago.`,
    aging: `Board data is aging — last updated more than ${aging} ago.`,
    stale: `Board data may be stale — the watcher has been offline for more than ${stale}.`,
  });
}

// Public status collapse (PRD D5): "unknown" — and any value we don't
// recognize — renders as the ONE neutral grey "Checking…" state. The page
// never shows an alarming or raw status to a stranger.
const pubStatus = (s) => (s === 'in' || s === 'out' ? s : 'checking');

/** Only http(s) deep links are ever interpolated into an anchor. */
const safeHref = (url) => (/^https?:\/\//i.test(String(url ?? '')) ? String(url) : null);

// Empty/first-deploy copy — exported so the skeleton (index.html) and tests
// stay on the same locked strings. noneIn moved to SUB_COPY (cadence-templated).
export const COPY = Object.freeze({
  warming: 'The board is warming up — waiting for the first snapshot from the watcher.',
  allIn: 'All watched plans are in stock right now.',
});

// ---------- locked subscription copy (DESIGN §7 + the two TECH-added keys) ----
// Templates carry {placeholders}; cadence-derived strings render via subCopy()
// and must equal DESIGN's locked literals byte-for-byte at cadence 300 s —
// tests pin both the templates and the rendered forms (TECH §fe-fresh, FE-U14).
export const SUB_COPY = Object.freeze({
  ctaGlobal: '🔔 Get restock alerts',
  ctaCard: '🔔 Notify me',
  panelTitle: 'Restock alerts → your Telegram',
  panelHonesty: 'Checks run about every {cadLong} — an alert can lag a restock by up to {cadShort}.',
  pickerHint: "Plans in stock now alert on their next restock — after they've gone out and come back.",
  pickNone: 'pick at least one plan',
  submitLabel: 'Subscribe — send my confirmation ▸',
  sending: 'Sending confirmation to your bot…',
  successTitle: 'Check your Telegram',
  successBody: 'Your confirmation card just arrived — the same pipe delivers your restock digest.',
  mergedBody: 'Subscription updated — you now watch {n} plans.',
  noneIn:
    'Nothing in stock right now — the board checks about every {cad}. Subscribe to get a Telegram card the moment a plan comes back.',
  errTokenFormat:
    "That doesn't look like a bot token — it should look like 8123456789:AA… (46+ characters). Re-copy it from @BotFather.",
  errTokenRejected:
    'Telegram rejected this token — re-copy it from @BotFather, or send /token there to reissue it.',
  errChatFormat: 'A chat id is just a number, like 521934882.',
  errChatNotFound: "Your bot can't message you yet — open it in Telegram, press Start, then retry.",
  errDiscover:
    "No chat found — open your new bot, press Start, then tap Find again. (A busy bot with a webhook can't be auto-read — paste the id manually.)",
  errRate: 'Too many attempts — try again in {s}s.',
  errCap: "The board's subscriber list is full — nothing was saved. Try again later.",
  errServer: 'Something broke on our side — nothing was saved. Try again in a minute.',
  chatFound: "Found it — that's your chat id.",
  mgNotFound: 'No subscription found for that token + chat id.',
  mgUpdated: 'Updated — you now watch {n} plans.',
  mgGone: 'Unsubscribed. Your token and plan list were deleted.',
  privacy:
    "We store exactly three things: your bot token, your chat id, your plan list. No account, no email, no cookies. Your bot can only message people who pressed Start on it — that's you. Unsubscribe here anytime, or send /revoke to @BotFather — that kills the token instantly.",
});

/** Render a SUB_COPY template: unknown keys → '', unmatched {vars} left as-is. */
export function subCopy(key, vars = {}) {
  return String(SUB_COPY[key] ?? '').replace(/\{(\w+)\}/g, (m, k) =>
    k in vars ? String(vars[k]) : m,
  );
}

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

  // Footer: IN gets Buy + honest in-stock age (Buy stays the single action —
  // never a bell, DESIGN §2); OUT and Checking… get the round-2 notify bell,
  // sharing .pfoot with the quiet since-line when one is present.
  let foot = '';
  if (st === 'in') {
    const href = safeHref(plan.deepLink);
    const buy = href
      ? `<a class="buy" href="${esc(href)}" target="_blank" rel="noopener">Buy now ▸</a>`
      : '';
    const since =
      plan.inSinceMs != null ? `<span class="since">in stock · ${fmtDur(now - plan.inSinceMs)}</span>` : '';
    if (buy || since) foot = `<div class="pfoot">${buy}${since}</div>`;
  } else {
    const bell = `<button type="button" class="notify" data-plan-id="${esc(plan.id)}" aria-label="Notify me when ${esc(plan.name)} restocks">${SUB_COPY.ctaCard}</button>`;
    const since =
      st === 'out' && plan.outSinceMs != null
        ? `<span class="since out">out of stock · ${fmtDur(now - plan.outSinceMs)}</span>`
        : '';
    foot = `<div class="pfoot">${bell}${since}</div>`;
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

// ---------- subscription panel builders (pure, DOM-free — TECH §fe-arch) ----

/** Map plan.id → display record for pickers, success lists and previews. */
export function planIndex(state) {
  const map = new Map();
  for (const dc of state?.datacenters ?? [])
    for (const g of dc.generations ?? [])
      for (const p of g.plans ?? [])
        map.set(p.id, {
          name: p.name,
          city: dc.city,
          loc: dc.loc,
          price: p.price,
          period: p.period ?? 'mo',
          status: pubStatus(p.status),
          deepLink: p.deepLink,
        });
  return map;
}

/**
 * Plan picker: one <details> accordion per DC in snapshot encounter order,
 * tri-state select-all per group, whole-row <label> hit targets. openLoc:
 * true = all groups open (desktop), a loc string = only that group open
 * (mobile / preselect), null = all collapsed. Structure formalizes the
 * approved MOCKUP.html picker (docs/pipeline/subscriptions/MOCKUP.html).
 */
export function pickerHTML(state, checkedSet = new Set(), openLoc = null) {
  return (state?.datacenters ?? [])
    .map((dc) => {
      const plans = (dc.generations ?? []).flatMap((g) => g.plans ?? []);
      const open = openLoc === true || openLoc === dc.loc;
      const rows = plans
        .map((p) => {
          const st = pubStatus(p.status);
          return `<label class="pick-row"><input type="checkbox" class="pick" data-plan-id="${esc(p.id)}" data-loc="${esc(dc.loc)}"${checkedSet.has(p.id) ? ' checked' : ''}><span class="pick-name">${esc(p.name)}</span><span class="pick-meta">${esc(p.price)} <span class="sdot ${st}" aria-hidden="true"></span>${st}</span></label>`;
        })
        .join('');
      return `<details class="pick-dc" data-loc="${esc(dc.loc)}"${open ? ' open' : ''}><summary><span class="tw" aria-hidden="true">▸</span>${esc(dc.flag)} <span>${esc(dc.city)}</span><span class="cnt">· ${plans.length}</span><span class="pick-all-w"><input type="checkbox" class="pick-all" data-loc="${esc(dc.loc)}" aria-label="Select all ${esc(dc.city)} plans">all</span></summary><div class="pick-rows">${rows}</div></details>`;
    })
    .join('');
}

// ---------- Telegram card previews (success pane echo — DESIGN §6 shapes) ----
// Client-side previews of the two cards the server sends; the server's
// notifier owns the real cards. plans = planIndex records.

/** Confirmation/receipt card preview: name — city bullets, no prices/links. */
export function tgConfirmPreview(plans, { merged = false, cadenceMs = null } = {}) {
  const n = plans.length;
  const min = Math.max(1, Math.round((Number.isFinite(cadenceMs) && cadenceMs > 0 ? cadenceMs : 60_000) / 60_000));
  const head = merged ? '🔄 Subscription updated' : '✅ Subscribed — VPS Stock Watch';
  const intro =
    n === 1
      ? "You'll get ONE digest card here when your plan restocks:"
      : `You'll get ONE digest card here when any of your <b>${n} plans</b> restock:`;
  const bullets = plans.map((p) => `• ${esc(p.name)} — ${esc(p.city)}`).join('<br>');
  return `<strong>${head}</strong><br><br>${intro}<br><br>${bullets}<div class="tgfoot">checks run ~every ${min} min · a plan re-alerts only after it goes out of stock again<br>manage: vps-stock.daichenlab.com/?manage=1</div>`;
}

/** Digest card preview: what a restock card will look like for these plans. */
export function tgDigestPreview(plans, { cadenceMs = null, now = Date.now() } = {}) {
  const n = plans.length;
  const min = Math.max(1, Math.round((Number.isFinite(cadenceMs) && cadenceMs > 0 ? cadenceMs : 60_000) / 60_000));
  const d = new Date(now);
  const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const bullets = plans
    .map(
      (p) =>
        `• <strong>${esc(p.name)}</strong> — ${esc(p.price)}/${esc(p.period)} — ${esc(p.city)} · <span class="tglink">Buy now</span>`,
    )
    .join('<br>');
  return `<strong>🟢 Restock — ${n} of your plans ${n === 1 ? 'is' : 'are'} IN STOCK</strong><br><br>${bullets}<div class="tgfoot">as of ${hhmm} UTC · data can lag ~${min} min<br>manage: vps-stock.daichenlab.com/?manage=1</div>`;
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
