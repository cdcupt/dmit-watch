// All DOM rendering for the panel. Reads the client store (js/store.js) and paints
// the DMIT-style Datacenter → Generation → Instance-Scale wall, plus the History,
// Health and Watchlist views. Pure presentation: stock/edge decisions already made
// server-side; here a card turns green ONLY on status:"in".

import { $, $$, esc, fmtAgo, fmtUptime, clock } from './util.js';
import * as store from './store.js';

const GEN_LABELS = { as3: 'EPYC 7003', an4: 'EPYC 9004', an5: 'EPYC 9005' };

const isAlarm = (p) => p.alarm === true && p.status === 'in';
const section = (p) => (isAlarm(p) ? 'alarm' : p.status === 'in' ? 'in' : 'waiting');

// ---------- instance-scale card ----------
// Exported for unit tests (pure: depends only on the plan object + esc/fmtAgo).
export function pcardHTML(p) {
  const inStock = p.status === 'in';
  const alarm = isAlarm(p);
  const cls = `pcard ${alarm ? 's-in alarm' : inStock ? 's-in' : `s-${p.status}`}`;
  // The status is the hero of the card. Only "out" asserts certainty;
  // unknown/checking is a state we don't know yet, so it renders a neutral grey
  // label (never green) — the panel never claims a definite status it lacks.
  const statusLabel = inStock
    ? '<span class="instockpill">IN STOCK</span>'
    : p.status === 'out'
      ? '<span class="oos">Out of Stock</span>'
      : '<span class="unk">Unknown</span>';
  const pop = p.popular ? '<span class="popular">Popular</span>' : '';
  const num = String(p.price ?? '').replace(/^\$/, '');
  const foot =
    inStock
      ? `<a class="buy focusable" href="${esc(p.deepLink)}" target="_blank" rel="noopener">Buy now ▸</a>`
      : p.status === 'checking'
        ? '<span class="fresh checking">checking now…</span>'
        : p.status === 'unknown'
          ? '<span class="fresh err">read error · retrying</span>'
          : `<span class="fresh" data-fresh="${esc(p.id)}">${p.lastCheckMs ? 'checked ' + fmtAgo(Date.now() - p.lastCheckMs) : 'not checked yet'}</span>`;
  return `<article class="${cls}" data-id="${esc(p.id)}" tabindex="0">
    <div class="pstatus">${statusLabel}</div>
    <div class="phead"><span class="pname">${esc(p.name)}</span><span class="pright">${pop}</span></div>
    <div class="price"><span class="cur">$</span><span class="num">${esc(num)}</span><span class="unit">USD</span><span class="per">/mo</span></div>
    <div class="setup">Free Setup</div>
    <div class="specs"><span aria-hidden="true">▤</span> vCPU · RAM — read at runtime</div>
    <div class="pfoot">${foot}</div>
  </article>`;
}

function waitingGroupsHTML() {
  const data = store.getData();
  if (!data) return '';
  return data.datacenters
    .map((dc) => {
      const waitingByGen = dc.generations
        .map((g) => ({ g, plans: g.plans.filter((p) => section(p) === 'waiting') }))
        .filter((x) => x.plans.length);
      const total = waitingByGen.reduce((n, x) => n + x.plans.length, 0);
      if (!total) return '';
      const allOut = waitingByGen.every((x) => x.plans.every((p) => p.status === 'out'));
      const gens = waitingByGen
        .map(
          ({ g, plans }) =>
            `<div class="gen-group"><div class="gen-card"><span class="epyc" aria-hidden="true">AMD<br>EPYC</span><div><div class="gen-code">${esc(g.label)}</div><div class="gen-series">AMD ${esc(g.cpu || GEN_LABELS[g.gen] || '')} Series</div></div><span class="gen-count">${plans.length} plans</span></div><div class="grid">${plans.map(pcardHTML).join('')}</div></div>`,
        )
        .join('');
      return `<section class="dc-group"><div class="dc-bar"><div class="dc-card"><span class="flag">${esc(dc.flag)}</span><div><div class="dc-city">${esc(dc.city)}</div><div class="dc-country">${esc(dc.country)}</div></div></div><span class="rp-badge">Premium</span><span class="dc-count">${total} watched${allOut ? ' · all out' : ''}</span></div>${gens}</section>`;
    })
    .join('');
}

// ---------- panel (with FLIP promotion) ----------
export function renderPanel(animate) {
  const data = store.getData();
  if (!data) return;
  const scope = $('#view-panel');
  const doFlip = animate && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const first = {};
  if (doFlip)
    scope.querySelectorAll('[data-id]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width) first[el.dataset.id] = r;
    });

  const plans = store.allPlans();
  const alarmP = plans.filter((p) => section(p) === 'alarm');
  const instock = plans.filter((p) => section(p) === 'in');
  const waiting = plans.filter((p) => section(p) === 'waiting');

  $('#alarmZone').innerHTML = alarmP.map(pcardHTML).join('');
  $('#alarmZone').style.display = alarmP.length ? '' : 'none';
  $('#waitingGroups').innerHTML = waitingGroupsHTML();
  $('#waitingEmpty').style.display = waiting.length ? 'none' : '';
  $('#instockGrid').innerHTML = instock.map(pcardHTML).join('');
  $('#instockEmpty').style.display = instock.length ? 'none' : '';

  renderStats();

  if (doFlip)
    scope.querySelectorAll('[data-id]').forEach((el) => {
      const f = first[el.dataset.id];
      if (!f) return;
      const l = el.getBoundingClientRect();
      if (!l.width) return;
      const dx = f.left - l.left;
      const dy = f.top - l.top;
      if (dx || dy) {
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px,${dy}px)`;
        requestAnimationFrame(() => {
          el.style.transition = 'transform var(--dur) var(--ease)';
          el.style.transform = '';
        });
      }
    });
}

export function renderStats() {
  const c = store.counts();
  const plans = store.allPlans();
  const waiting = plans.filter((p) => section(p) === 'waiting').length;
  const instock = plans.filter((p) => section(p) === 'in').length;
  $('#stTotal').textContent = c.total;
  $('#stIn').textContent = c.in;
  $('#stWait').textContent = c.waiting;
  $('#stInWrap').className = `stat-hero ${c.in > 0 ? 'in1' : 'in0'}`;
  $('#cntWaiting').textContent = waiting;
  $('#cntInline').textContent = c.in;
  $('#cntInstock').textContent = instock;
  const locs = Object.entries(c.byLoc).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(' · ');
  const gens = Object.entries(c.byGen).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(' · ');
  $('#breakdown').innerHTML = `${esc(locs)}&nbsp;&nbsp;·&nbsp;&nbsp;${esc(gens)}`;
}

// ---------- connection lamp ----------
// SSE link state: live (green) vs connecting/reconnecting (amber, gentle pulse).
// The element carries aria-live="polite" so the change is announced.
export function renderConnLamp(state) {
  const lamp = $('#connLamp');
  if (!lamp) return;
  const s = state === 'live' ? 'live' : state === 'connecting' ? 'connecting' : 'reconnecting';
  lamp.className = `lamp conn ${s}`;
  $('#connLabel').textContent = s === 'live' ? 'live' : s === 'connecting' ? 'connecting…' : 'reconnecting…';
}

// ---------- watcher lamp ----------
export function renderWatcherLamp() {
  const w = store.getWatcher() ?? {};
  const lamp = $('#watcherLamp');
  const status = w.status ?? 'running';
  lamp.className = `lamp ${status === 'running' ? 'run' : status}`;
  $('#watcherLabel').textContent =
    status === 'running' ? 'WATCHER RUNNING' : status === 'degraded' ? 'WATCHER DEGRADED' : 'WATCHER DOWN';
}

export function tickFreshness() {
  $$('[data-fresh]').forEach((el) => {
    const id = el.getAttribute('data-fresh');
    const p = store.allPlans().find((x) => x.id === id);
    if (p && p.status === 'out' && p.lastCheckMs) el.textContent = 'checked ' + fmtAgo(Date.now() - p.lastCheckMs);
  });
  const w = store.getWatcher() ?? {};
  if (w.uptimeMs != null) $('#uptime').textContent = fmtUptime(w.uptimeMs);
}

// ---------- history ----------
export function renderHistory() {
  const rows = store.getHistory();
  $('#historyEmpty').style.display = rows.length ? 'none' : '';
  $('#historyList').innerHTML = rows
    .slice()
    .sort((a, b) => b.t - a.t)
    .map((h) => {
      const dir = h.to === 'in' ? 'toIN' : 'toOUT';
      const chip =
        h.to === 'in'
          ? '<span class="chip in"><span class="dot"></span>→ IN</span>'
          : '<span class="tg fail">→ OUT</span>';
      return `<div class="row ${dir}"><div class="lead-l"><span class="skuname">${esc(h.name)}</span>${chip}<span class="meta">${clock(h.t)}${h.dur ? ' · ' + esc(h.dur) : ''}</span></div><span class="when">${fmtAgo(Date.now() - h.t)}</span></div>`;
    })
    .join('');
}

// ---------- health ----------
export function renderHealth(health) {
  if (!health) return;
  const chip = $('#chromeChip');
  const st = health.chrome?.state ?? 'unknown';
  const up = /up|clear|logged/i.test(st);
  chip.className = up ? 'chip in' : 'chip bk';
  chip.innerHTML = `<span class="dot"></span>${esc(String(st).toUpperCase())}`;
  $('#schedTick').textContent = health.scheduler?.lastTickMs ? fmtAgo(Date.now() - health.scheduler.lastTickMs) : '—';

  $('#healthList').innerHTML = (health.families ?? [])
    .map((f) => {
      // Blind outranks backoff: detection is paused, which can hide a restock.
      const right = f.blind
        ? `<span class="chip bk"><span class="dot"></span>BLIND${f.blindSinceMs ? ' ' + esc(fmtAgo(Date.now() - f.blindSinceMs).replace(/ ago$/, '')) : ''}${f.blindReasons?.length ? ` · ${esc(f.blindReasons.join(', '))}` : ''}</span>`
        : f.backoff > 0
          ? `<span class="chip bk"><span class="dot"></span>BACKOFF ×${f.backoff}</span>`
          : `<span class="meta">last poll ${f.lastPollMs ? fmtAgo(Date.now() - f.lastPollMs) : '—'}</span>`;
      return `<div class="row"><div class="lead-l"><span class="skuname">${esc(f.label)}</span><span class="meta">${esc(f.sub)} · ${f.count} plans</span></div>${right}</div>`;
    })
    .join('');

  const tg = health.telegram ?? [];
  $('#telegramEmpty').style.display = tg.length ? 'none' : '';
  $('#telegramList').innerHTML = tg
    .slice()
    .sort((a, b) => b.ts - a.ts)
    .map((m) => {
      const badge = m.ok
        ? '<span class="tg ok">Telegram sent ✓</span>'
        : '<span class="tg fail">Telegram failed ✗ · retry queued</span>';
      return `<div class="row"><div class="lead-l"><span class="skuname">${esc(m.name)}</span><span class="meta">${clock(m.ts)}</span></div>${badge}</div>`;
    })
    .join('');
}

// ---------- watchlist ----------
export function renderWatchlist(onRemove) {
  const fams = store.families();
  $('#watchlist').innerHTML = fams
    .map(
      (f) =>
        `<div class="row"><div class="lead-l"><span class="skuname">${esc(f.label)}</span><span class="meta">${esc(f.sub)} · ${f.count} plans</span></div><button class="removebtn focusable" data-rm="${esc(f.key)}">remove ✕</button></div>`,
    )
    .join('');
  $$('[data-rm]').forEach((b) => {
    b.onclick = () => onRemove(b.dataset.rm);
  });
}
