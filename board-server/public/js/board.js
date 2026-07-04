// Public board bootstrap (TECH §10): one jittered GET /api/state poll loop, a
// 1 s age ticker, and a paint per genuinely-new snapshot. Freshness is computed
// from receivedAt only against the server-corrected clock — fetch success is
// never a freshness signal, and a poll failure never touches the ladder. This
// bundle is read-only by construction: no SSE, no audio, no POST anywhere.

import { $, fmtAgo, reduceMotion } from './util.js';
import { paint, freshTier } from './render.js';

// Timing constants — single source (TECH §10 table).
const POLL_MS = 30_000; // base fetch interval
const POLL_JITTER_MS = 5_000; // 0–5 s random per cycle (de-syncs open tabs)
const TICK_MS = 1_000; // age-label ticker
const BACKOFF_CAP_MS = 300_000; // failure interval = POLL_MS × 2ⁿ capped here

// Screen-reader copy per tier — announced on TRANSITIONS only, never per tick.
const TIER_MSG = Object.freeze({
  fresh: 'Board data is fresh — updated under 2 minutes ago.',
  aging: 'Board data is aging — last updated more than 2 minutes ago.',
  stale: 'Board data may be stale — the watcher has been offline for more than 5 minutes.',
});

let receivedAt = null; // server truth: when the last push landed (null = warming)
let skewMs = 0; // Date.now() − server now (0 when now is absent)
let failures = 0; // consecutive poll failures (drives backoff only)
let pollTimer = null;
let tickTimer = null;
let lastTier = null;

const age = () => Math.max(0, Date.now() - skewMs - receivedAt);

// ---------- age ticker (label writes only; tier class on transitions) ----------
function tick() {
  if (receivedAt == null) return; // no age to be honest about yet
  const a = age();
  $('#freshLabel').textContent = 'updated ' + fmtAgo(a);
  $('#staleAge').textContent = fmtAgo(a);
  const tier = freshTier(a);
  if (tier === lastTier) return;
  lastTier = tier;
  $('#freshPill').className = 'lamp fresh-pill' + (tier === 'fresh' ? '' : ' ' + tier);
  document.body.classList.toggle('stale', tier === 'stale');
  $('#staleBanner').classList.toggle('show', tier === 'stale');
  $('#freshStatus').textContent = TIER_MSG[tier]; // sr-only role=status sibling
}

function startTicker() {
  clearInterval(tickTimer);
  tickTimer = setInterval(tick, TICK_MS);
}

// ---------- paint with FLIP promotion (skipped under reduced motion) ----------
function flipPaint(state, now) {
  const doFlip = !reduceMotion();
  const first = {};
  if (doFlip)
    document.querySelectorAll('[data-id]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width) first[el.dataset.id] = r;
    });
  paint(state, { now });
  if (!doFlip) return;
  document.querySelectorAll('[data-id]').forEach((el) => {
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

// ---------- snapshot envelope → board ----------
function apply(body) {
  skewMs = typeof body.now === 'number' ? Date.now() - body.now : 0;
  if (body.receivedAt == null || body.state == null) {
    // Warming up (never a 404/500): dashed empty block, pill hidden.
    receivedAt = null;
    lastTier = null;
    $('#freshPill').hidden = true;
    paint(null);
    return;
  }
  const isNew = body.receivedAt !== receivedAt; // re-render gate
  receivedAt = body.receivedAt;
  $('#freshPill').hidden = false;
  if (isNew) flipPaint(body.state, Date.now() - skewMs);
  tick(); // honest label + tier immediately, not at the next second
}

// ---------- fetch loop with ×2 backoff on consecutive failures ----------
async function poll() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    apply(await res.json());
    failures = 0;
  } catch {
    // Keep the last rendered board — the age keeps ticking and escalates
    // toward stale naturally. No error UI, no copy change; just back off.
    failures += 1;
  }
  arm();
}

const nextDelay = () =>
  failures > 0
    ? Math.min(POLL_MS * 2 ** failures, BACKOFF_CAP_MS)
    : POLL_MS + Math.random() * POLL_JITTER_MS;

function arm() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (document.hidden) return; // no background fetching
  pollTimer = setTimeout(poll, nextDelay());
}

// Tab hidden → clear both timers; visible → recompute the tier once (the board
// may have gone stale while hidden), fetch immediately, restart both timers.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(pollTimer);
    pollTimer = null;
    clearInterval(tickTimer);
    tickTimer = null;
  } else {
    tick();
    startTicker();
    if (!demoMode) poll();
  }
});

// ---------- demo affordance (dev-only, no UI entry point) ----------
// `?demo=1` renders an inline sample snapshot — mixed IN/OUT/checking plus the
// qq.pw WHMCS section — with a small "demo data" chip, so the page is visually
// verifiable straight from disk with no server. Never linked from the page.
const demoMode = new URLSearchParams(location.search).get('demo') === '1';

function demoSnapshot(now) {
  const plan = (id, name, price, over = {}) => ({
    id,
    name,
    price,
    period: 'mo',
    popular: false,
    status: 'out',
    deepLink: 'https://www.dmit.io/cart.php?a=add&pid=' + id,
    inSinceMs: null,
    ...over,
  });
  const min = 60_000;
  return {
    counts: { total: 22, in: 2, waiting: 20, byLoc: { lax: 9, hkg: 5, tyo: 4, hnl: 4 } },
    datacenters: [
      {
        loc: 'lax', code: 'LAX', city: 'Los Angeles', country: 'United States', flag: '🇺🇸',
        generations: [
          { key: 'lax/as3', gen: 'as3', label: 'AS3', cpu: 'AMD EPYC 7003 Series', plans: [
            plan('101', 'LAX.AS3.Pro.TINY', '$10.90', { popular: true, outSinceMs: now - (3 * 24 * 60 + 4 * 60) * min }),
            plan('102', 'LAX.AS3.Pro.POCKET', '$16.90'),
            plan('103', 'LAX.AS3.Pro.STARTER', '$34.90'),
            plan('104', 'LAX.AS3.Pro.MINI', '$62.90', { outSinceMs: now - 47 * min }),
            plan('105', 'LAX.AS3.Pro.MICRO', '$87.90'),
            plan('106', 'LAX.AS3.Pro.MEDIUM', '$199.90'),
          ]},
          { key: 'lax/an5', gen: 'an5', label: 'AN5', cpu: 'AMD EPYC 9005 Series', plans: [
            plan('111', 'LAX.AN5.Pro.MINI', '$79.90'),
            plan('112', 'LAX.AN5.Pro.MICRO', '$110.90', { status: 'checking' }),
            plan('113', 'LAX.AN5.Pro.MEDIUM', '$289.90'),
          ]},
        ],
      },
      {
        loc: 'hkg', code: 'HKG', city: 'Hong Kong', country: 'China', flag: '🇭🇰',
        generations: [
          { key: 'hkg/as3', gen: 'as3', label: 'AS3', cpu: 'AMD EPYC 7003 Series', plans: [
            plan('201', 'HKG.AS3.Pro.TINY', '$39.90', { popular: true, status: 'in', inSinceMs: now - 26 * min }),
            plan('202', 'HKG.AS3.Pro.STARTER', '$79.90'),
            plan('203', 'HKG.AS3.Pro.MINI', '$126.90'),
            plan('204', 'HKG.AS3.Pro.MICRO', '$179.90', { outSinceMs: now - (2 * 60 + 14) * min }),
            plan('205', 'HKG.AS3.Pro.MEDIUM', '$239.90'),
          ]},
        ],
      },
      {
        loc: 'tyo', code: 'TYO', city: 'Tokyo', country: 'Japan', flag: '🇯🇵',
        generations: [
          { key: 'tyo/as3', gen: 'as3', label: 'AS3', cpu: 'AMD EPYC 7003 Series', plans: [
            plan('301', 'TYO.AS3.Pro.TINY', '$21.90', { popular: true }),
            plan('302', 'TYO.AS3.Pro.STARTER', '$45.90', { status: 'in', inSinceMs: now - (2 * 60 + 14) * min }),
            plan('303', 'TYO.AS3.Pro.MINI', '$89.90', { status: 'unknown' }), // renders as Checking…
            plan('304', 'TYO.AS3.Pro.MICRO', '$189.90'),
          ]},
        ],
      },
      {
        loc: 'hnl', code: 'HNL', city: 'Honolulu', country: 'United States · Hawaii', flag: '🇺🇸',
        generations: [
          { key: 'hnl/vds', gen: 'vds', label: 'VDS', cpu: 'AMD Ryzen 7940HS · residential IP', provider: 'whmcs', plans: [
            plan('401', 'Dedicate IP VDS Intern', '$35.00', { deepLink: 'https://qq.pw/cart.php?a=add&pid=401', specs: 'Ryzen 7940HS · dedicated IP' }),
            plan('402', 'Dedicate IP VDS Reliable', '$35.00', { deepLink: 'https://qq.pw/cart.php?a=add&pid=402', specs: 'Ryzen 7940HS · dedicated IP' }),
            plan('403', 'Dedicate IP VDS Hardcore', '$45.00', { deepLink: 'https://qq.pw/cart.php?a=add&pid=403', outSinceMs: now - 9 * 24 * 60 * min }),
            plan('404', 'Dedicate IP VDS Elite', '$165.00', { deepLink: 'https://qq.pw/cart.php?a=add&pid=404', period: 'quarter' }),
          ]},
        ],
      },
    ],
  };
}

// ---------- boot ----------
function boot() {
  startTicker();
  if (demoMode) {
    const chip = document.createElement('span');
    chip.className = 'demochip';
    chip.textContent = 'demo data';
    document.body.appendChild(chip);
    const now = Date.now();
    apply({ v: 1, pushedAt: now - 39_000, receivedAt: now - 38_000, now, state: demoSnapshot(now) });
    return; // demo is a static render — no polling
  }
  poll();
}

boot();
