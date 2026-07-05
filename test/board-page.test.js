// DOM-free render tests for the public board page (frontend.test.js idiom):
// the board's builders are pure JSON→HTML-string functions, so status variants,
// freshness tiers, provider badges and the locked public copy are all asserted
// in plain Node — no jsdom, no timers, no network. Ages are always injected
// literal milliseconds against a fixed clock (never a real wait).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cardHTML,
  freshTier,
  dcBadge,
  dcGroupHTML,
  genGroupHTML,
  inStockCards,
  jumpChipsHTML,
  statsModel,
  COPY,
  AGING_MS,
  STALE_MS,
} from '../board-server/public/js/render.js';
import { esc, fmtDur, fmtAgo } from '../board-server/public/js/util.js';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'board-server', 'public');
const NOW = 1_700_000_000_000; // injected clock — every age below is literal ms
const MIN = 60_000;

const plan = (over) => ({
  id: 'p1',
  name: 'HKG.AS3.Pro.TINY',
  price: '$39.90',
  period: 'mo',
  popular: false,
  status: 'out',
  deepLink: 'https://www.dmit.io/cart.php?a=add&pid=1',
  inSinceMs: null,
  ...over,
});

// ---- locked public copy (PM decision, Gate 2) -------------------------------

test('index.html carries the locked multi-provider title + subtitle', () => {
  const html = readFileSync(join(PUB, 'index.html'), 'utf8');
  assert.match(html, /<title>VPS Stock Watch — live availability across watched providers<\/title>/);
  assert.match(html, /Live availability across watched VPS providers · read-only board/);
  assert.match(html, /name="description"/);
  assert.doesNotMatch(html, /noindex/); // this page is meant to be shared
});

test('index.html never reads as DMIT-only (repo link aside)', () => {
  const html = readFileSync(join(PUB, 'index.html'), 'utf8');
  const withoutRepoLink = html.replaceAll(/github\.com\/cdcupt\/dmit-watch/g, '');
  assert.doesNotMatch(withoutRepoLink, /dmit/i);
  assert.doesNotMatch(html, /live DMIT Premium availability/); // the pre-Gate-2 title
});

test('index.html carries the warming-up and empty-state copy', () => {
  const html = readFileSync(join(PUB, 'index.html'), 'utf8');
  assert.match(html, new RegExp(COPY.warming));
  assert.match(html, new RegExp(COPY.noneIn));
  assert.match(html, new RegExp(COPY.allIn));
});

// ---- card status matrix (incl. the unknown→checking collapse) ---------------

test('cardHTML: IN renders green card, Buy link and since-age', () => {
  const html = cardHTML(plan({ status: 'in', popular: true, inSinceMs: NOW - 26 * MIN }), '🇭🇰 Hong Kong · AMD EPYC 7003 Series', NOW);
  assert.match(html, /pcard s-in/);
  assert.match(html, /instockpill/);
  assert.match(html, /<a class="buy" href="https:\/\/www\.dmit\.io\/cart\.php\?a=add&amp;pid=1" target="_blank" rel="noopener">/);
  assert.match(html, /in stock · 26m/);
  assert.match(html, /class="popular"/);
  assert.match(html, /class="ctxline">🇭🇰 Hong Kong · AMD EPYC 7003 Series/);
  assert.match(html, /data-id="p1"/);
});

test('cardHTML: IN without inSinceMs renders the Buy button alone', () => {
  const html = cardHTML(plan({ status: 'in' }), null, NOW);
  assert.match(html, /class="buy"/);
  assert.doesNotMatch(html, /class="since"/);
  assert.doesNotMatch(html, /ctxline/); // wall context never leaks without ctx
});

test('cardHTML: OUT is quiet — no footer at all without outSinceMs', () => {
  const html = cardHTML(plan({ status: 'out' }), null, NOW);
  assert.match(html, /pcard s-out/);
  assert.match(html, /class="oos">Out of Stock/);
  assert.doesNotMatch(html, /pfoot/);
  assert.doesNotMatch(html, /class="buy"/);
});

test('cardHTML: OUT with outSinceMs renders the quiet muted line (render-if-present)', () => {
  const html = cardHTML(plan({ status: 'out', outSinceMs: NOW - (2 * 60 + 14) * MIN }), null, NOW);
  assert.match(html, /class="since out">out of stock · 2h 14m/);
  assert.doesNotMatch(html, /class="buy"/);
});

test('cardHTML: checking/unknown/garbage all collapse to ONE neutral state', () => {
  for (const status of ['checking', 'unknown', 'total-garbage']) {
    const html = cardHTML(plan({ status }), null, NOW);
    assert.match(html, /pcard s-checking/, status);
    assert.match(html, /class="unk">Checking…/, status);
    // neutral means neutral: no warn/red classes, no buy, no raw status text
    assert.doesNotMatch(html, /warn|s-out|s-in|oos|instockpill|pfoot/, status);
    assert.doesNotMatch(html, /unknown|garbage/, status);
  }
});

test('cardHTML: specs row only when a real non-empty value exists', () => {
  assert.match(cardHTML(plan({ specs: '1 vCPU · 1 GB · CN2 GIA' }), null, NOW), /class="specs"/);
  assert.doesNotMatch(cardHTML(plan({}), null, NOW), /class="specs"/);
  assert.doesNotMatch(cardHTML(plan({ specs: '' }), null, NOW), /class="specs"/);
});

test('cardHTML: deepLink scheme gate — only http(s) URLs render an anchor', () => {
  for (const deepLink of ['javascript:alert(1)', 'data:text/html,x', '', null]) {
    const html = cardHTML(plan({ status: 'in', deepLink, inSinceMs: NOW - MIN }), null, NOW);
    assert.doesNotMatch(html, /<a /, String(deepLink));
    assert.match(html, /in stock · 1m/); // the since line still renders
  }
});

test('cardHTML: plan fields are entity-escaped, never live markup', () => {
  const html = cardHTML(plan({ name: '<script>alert(1)</script>', price: '"9.99"' }), null, NOW);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;9\.99&quot;/);
});

// ---- freshness ladder (injected ages only — no timers anywhere) -------------

test('freshTier: exact boundaries at 2 min and 5 min', () => {
  assert.equal(AGING_MS, 120_000);
  assert.equal(STALE_MS, 300_000);
  assert.equal(freshTier(0), 'fresh');
  assert.equal(freshTier(119_000), 'fresh');
  assert.equal(freshTier(120_000), 'fresh'); // fresh ≤ 2 min
  assert.equal(freshTier(121_000), 'aging');
  assert.equal(freshTier(299_000), 'aging'); // T+4:59 — no banner tier yet
  assert.equal(freshTier(300_000), 'aging'); // stale strictly after 5 min
  assert.equal(freshTier(301_000), 'stale'); // T+5:01 — banner tier
});

// ---- formatting helpers ------------------------------------------------------

test('fmtDur: since-line formats', () => {
  assert.equal(fmtDur(38_000), '38s');
  assert.equal(fmtDur(26 * MIN), '26m');
  assert.equal(fmtDur((2 * 60 + 14) * MIN), '2h 14m');
  assert.equal(fmtDur((3 * 24 + 4) * 60 * MIN), '3d 4h');
  assert.equal(fmtDur(-5), '0s'); // clamped, never negative
});

test('fmtAgo: pill label formats', () => {
  assert.equal(fmtAgo(38_000), '38s ago');
  assert.equal(fmtAgo(190_000), '3m 10s ago');
});

test('esc: escapes the HTML-significant characters', () => {
  assert.equal(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(esc(null), '');
});

// ---- stats strip (counts used verbatim; per-location breakdown only) --------

test('statsModel: counts verbatim, hero class, badges, byLoc breakdown', () => {
  const m = statsModel({ total: 37, in: 2, waiting: 35, byLoc: { lax: 16, hkg: 10, tyo: 7, hnl: 4 }, byGen: { as3: 9 } });
  assert.equal(m.in, 2);
  assert.equal(m.waiting, 35);
  assert.equal(m.total, 37);
  assert.equal(m.heroClass, 'stat-hero in1');
  assert.equal(m.breakdown, 'LAX 16 · HKG 10 · TYO 7 · HNL 4'); // never byGen
  assert.equal(m.inBadge, '2 plans · buy while they last');
  assert.equal(m.waitBadge, '35 plans · grouped by datacenter');
});

test('statsModel: zero in stock mutes the hero; singular badge at one', () => {
  assert.equal(statsModel({ total: 5, in: 0, waiting: 5, byLoc: {} }).heroClass, 'stat-hero in0');
  assert.equal(statsModel({ total: 5, in: 1, waiting: 4, byLoc: {} }).inBadge, '1 plan · buy while they last');
});

// ---- provider badge + DC/gen grouping ----------------------------------------

const dc = (over) => ({
  loc: 'hnl',
  code: 'HNL',
  city: 'Honolulu',
  country: 'United States',
  flag: '🇺🇸',
  generations: [
    { key: 'hnl/vds', gen: 'vds', label: 'VDS', cpu: 'AMD Ryzen 7940HS', provider: 'whmcs', plans: [plan({ id: 'v1' })] },
  ],
  ...over,
});

test('dcBadge: provider comes from the data — whmcs → qq.pw, default → DMIT', () => {
  assert.equal(dcBadge(dc({})), 'qq.pw · WHMCS');
  const dmit = dc({ generations: [{ key: 'lax/as3', label: 'AS3', cpu: 'AMD EPYC 7003 Series', plans: [] }] });
  assert.equal(dcBadge(dmit), 'DMIT · Premium'); // absent field falls back defensively
  assert.match(dcGroupHTML(dc({}), NOW), /rp-badge">qq\.pw · WHMCS/);
});

test('dcGroupHTML: anchor id, watched count, and the in-stock/all-out suffixes', () => {
  const mixed = dc({
    generations: [{ key: 'hnl/vds', label: 'VDS', cpu: 'x', plans: [plan({ id: 'a', status: 'in', inSinceMs: NOW - MIN }), plan({ id: 'b', status: 'out' })] }],
  });
  const html = dcGroupHTML(mixed, NOW);
  assert.match(html, /id="dc-hnl"/);
  assert.match(html, /2 watched · 1 in stock ↑/);

  const allOut = dc({ generations: [{ key: 'k', label: 'VDS', cpu: 'x', plans: [plan({ id: 'a' }), plan({ id: 'b', status: 'out' })] }] });
  assert.match(dcGroupHTML(allOut, NOW), /2 watched · all out/);

  const checking = dc({ generations: [{ key: 'k', label: 'VDS', cpu: 'x', plans: [plan({ id: 'a', status: 'checking' })] }] });
  assert.match(dcGroupHTML(checking, NOW), /1 watched</); // checking ≠ "all out"
});

test('genGroupHTML: EPYC chip from cpu, gen chip from label otherwise', () => {
  const epyc = genGroupHTML({ label: 'AS3', cpu: 'AMD EPYC 7003 Series', plans: [plan({})] }, NOW);
  assert.match(epyc, /AMD<br>EPYC/);
  assert.match(epyc, /gen-series">AMD EPYC 7003 Series/);
  const vds = genGroupHTML({ label: 'VDS', cpu: 'AMD Ryzen 7940HS', plans: [plan({})] }, NOW);
  assert.match(vds, /epyc" aria-hidden="true">VDS</);
});

test('genGroupHTML: a gen whose plans are all IN is omitted from the wall', () => {
  assert.equal(genGroupHTML({ label: 'AS3', cpu: 'x', plans: [plan({ status: 'in' })] }, NOW), '');
  assert.equal(genGroupHTML({ label: 'AS3', cpu: 'x', plans: [] }, NOW), '');
});

// ---- section partition + ordering ---------------------------------------------

test('inStockCards: only IN plans, snapshot encounter order, context carried', () => {
  const state = {
    datacenters: [
      dc({ loc: 'lax', city: 'Los Angeles', flag: '🇺🇸', generations: [
        { key: 'lax/as3', label: 'AS3', cpu: 'AMD EPYC 7003 Series', plans: [
          plan({ id: 'w1', status: 'out' }),
          plan({ id: 'i1', name: 'LAX.FIRST', status: 'in', inSinceMs: NOW - MIN }),
        ]},
      ]}),
      dc({ loc: 'tyo', city: 'Tokyo', flag: '🇯🇵', generations: [
        { key: 'tyo/as3', label: 'AS3', cpu: 'AMD EPYC 7003 Series', plans: [
          plan({ id: 'i2', name: 'TYO.SECOND', status: 'in', inSinceMs: NOW - MIN }),
          plan({ id: 'w2', status: 'checking' }),
        ]},
      ]}),
    ],
  };
  const cards = inStockCards(state, NOW);
  assert.equal(cards.length, 2);
  assert.match(cards[0], /LAX\.FIRST/); // encounter order, no client-side sorting
  assert.match(cards[1], /TYO\.SECOND/);
  assert.match(cards[0], /ctxline">🇺🇸 Los Angeles · AMD EPYC 7003 Series/);
  // and the wall keeps the non-IN plans (config order untouched)
  const wall = state.datacenters.map((d) => dcGroupHTML(d, NOW)).join('');
  assert.doesNotMatch(wall, /LAX\.FIRST|TYO\.SECOND/);
  assert.match(wall, /data-id="w1"[\s\S]*data-id="w2"/);
});

test('jumpChipsHTML: flag + code chips anchored to #dc-<loc>', () => {
  const html = jumpChipsHTML([dc({}), dc({ loc: 'lax', code: 'LAX', flag: '🇺🇸' })]);
  assert.match(html, /href="#dc-hnl">🇺🇸 HNL</);
  assert.match(html, /href="#dc-lax">🇺🇸 LAX</);
});
