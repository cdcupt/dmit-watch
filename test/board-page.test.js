// DOM-free render tests for the public board page (frontend.test.js idiom):
// the board's builders are pure JSON→HTML-string functions, so status variants,
// freshness tiers, provider badges and the locked public copy are all asserted
// in plain Node — no jsdom, no timers, no network. Ages are always injected
// literal milliseconds against a fixed clock (never a real wait). Round 2
// extends this with the subscription panel's pure exports (FE-U11…U18), the
// subscribe.js transport/validation/routing contract, and the rewritten
// static read-only audit (TECH §9/§B7 — rewritten, never deleted).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
  SUB_COPY,
  subCopy,
  fmtCadence,
  tierMsgs,
  pickerHTML,
  planIndex,
  tgConfirmPreview,
  tgDigestPreview,
  AGING_MULT,
  STALE_MULT,
  FALLBACK_AGING_MS,
  FALLBACK_STALE_MS,
} from '../board-server/public/js/render.js';
import {
  TOKEN_RE,
  CHAT_RE,
  API_TIMEOUT_MS,
  parseRetryAfter,
  fmtRetry,
  rateState,
  api,
  routeOutcome,
  manageLoadModel,
  updateDraft,
} from '../board-server/public/js/subscribe.js';
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
  // noneIn is cadence-templated now — the skeleton ships the 5-minute default.
  assert.ok(html.includes(subCopy('noneIn', { cad: fmtCadence(300_000).long })));
  assert.match(html, new RegExp(COPY.allIn));
});

test('index.html static copy is recalibrated to the 5-minute cadence', () => {
  const html = readFileSync(join(PUB, 'index.html'), 'utf8');
  assert.match(html, /checked about every 5 minutes/); // <meta description> (SMK-11)
  assert.match(html, /<b id="cadExplainer">about every 5 minutes<\/b>/);
  assert.match(html, /<b id="cadFooter">about every 5 minutes<\/b>/);
  assert.match(html, /Restock alerts are sent by <b>your own<\/b> Telegram bot/);
  assert.doesNotMatch(html, /every ~60\s?&nbsp;?s|about every minute/); // old 60 s literals gone
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

// FE-U15 — the round-2 bell matrix: IN never gets a bell (Buy stays the single
// action); OUT and Checking… always do, sharing .pfoot with the since-line.
test('cardHTML: OUT renders the notify bell (with and without the since-line)', () => {
  const bare = cardHTML(plan({ status: 'out' }), null, NOW);
  assert.match(bare, /pcard s-out/);
  assert.match(bare, /class="oos">Out of Stock/);
  assert.match(bare, /<button type="button" class="notify" data-plan-id="p1" aria-label="Notify me when HKG\.AS3\.Pro\.TINY restocks">🔔 Notify me<\/button>/);
  assert.doesNotMatch(bare, /class="since/);
  assert.doesNotMatch(bare, /class="buy"/);

  const since = cardHTML(plan({ status: 'out', outSinceMs: NOW - (2 * 60 + 14) * MIN }), null, NOW);
  assert.match(since, /class="notify"[\s\S]*class="since out">out of stock · 2h 14m/); // coexist in .pfoot
  assert.doesNotMatch(since, /class="buy"/);
});

test('cardHTML: IN never renders a bell — Buy stays the single action', () => {
  for (const over of [{ status: 'in' }, { status: 'in', inSinceMs: NOW - MIN }]) {
    const html = cardHTML(plan(over), null, NOW);
    assert.doesNotMatch(html, /class="notify"/);
    assert.match(html, /class="buy"/);
  }
});

test('cardHTML: checking/unknown/garbage collapse to ONE neutral state, bell only', () => {
  for (const status of ['checking', 'unknown', 'total-garbage']) {
    const html = cardHTML(plan({ status }), null, NOW);
    assert.match(html, /pcard s-checking/, status);
    assert.match(html, /class="unk">Checking…/, status);
    assert.match(html, /class="notify"/, status); // bell, same markup as OUT
    // neutral means neutral: no warn/red classes, no buy, no raw status text
    assert.doesNotMatch(html, /warn|s-out|s-in|oos|instockpill|class="since/, status);
    assert.doesNotMatch(html, /unknown|garbage/, status);
  }
});

test('cardHTML: bell data-plan-id and aria-label are entity-escaped', () => {
  const html = cardHTML(plan({ id: 'a"b', name: '<x> & "y"' }), null, NOW);
  assert.match(html, /data-plan-id="a&quot;b"/);
  assert.match(html, /aria-label="Notify me when &lt;x&gt; &amp; &quot;y&quot; restocks"/);
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
// FE-U11 / AUD-R6 — rewrites the round-1 fixed-constant boundaries (this
// file's original :135-144 anchor) as cadence-parameterized pairs: strictly
// after 2× cadence and 4× cadence, at BOTH 60 s and 300 s, plus the null-
// cadence fallback pinning the round-1 120 s / 300 s ladder exactly.

test('freshTier: exported multiplier and fallback constants', () => {
  assert.equal(AGING_MULT, 2);
  assert.equal(STALE_MULT, 4);
  assert.equal(FALLBACK_AGING_MS, 120_000);
  assert.equal(FALLBACK_STALE_MS, 300_000);
});

test('freshTier: ±1 s boundary pairs at cadence 60 s (2 min / 4 min)', () => {
  const CAD = 60_000;
  assert.equal(freshTier(0, CAD), 'fresh');
  assert.equal(freshTier(119_000, CAD), 'fresh');
  assert.equal(freshTier(120_000, CAD), 'fresh'); // strictly-after semantics kept
  assert.equal(freshTier(121_000, CAD), 'aging');
  assert.equal(freshTier(239_000, CAD), 'aging');
  assert.equal(freshTier(240_000, CAD), 'aging'); // stale strictly after 4×
  assert.equal(freshTier(241_000, CAD), 'stale');
});

test('freshTier: ±1 s boundary pairs at cadence 300 s (10 min / 20 min)', () => {
  const CAD = 300_000;
  assert.equal(freshTier(599_000, CAD), 'fresh');
  assert.equal(freshTier(600_000, CAD), 'fresh');
  assert.equal(freshTier(601_000, CAD), 'aging');
  assert.equal(freshTier(1_199_000, CAD), 'aging');
  assert.equal(freshTier(1_200_000, CAD), 'aging');
  assert.equal(freshTier(1_201_000, CAD), 'stale');
});

test('freshTier: null cadence reproduces the round-1 120 s / 300 s ladder exactly', () => {
  for (const cad of [null, undefined, 0, -5, NaN]) {
    assert.equal(freshTier(119_000, cad), 'fresh', String(cad));
    assert.equal(freshTier(120_000, cad), 'fresh', String(cad));
    assert.equal(freshTier(121_000, cad), 'aging', String(cad));
    assert.equal(freshTier(299_000, cad), 'aging', String(cad));
    assert.equal(freshTier(300_000, cad), 'aging', String(cad));
    assert.equal(freshTier(301_000, cad), 'stale', String(cad));
  }
});

// FE-U12 — sr tier strings derive from the SAME thresholds, never literals.
test('tierMsgs: derived minutes at 300 s, round-1 strings verbatim at null', () => {
  const at300 = tierMsgs(300_000);
  assert.match(at300.fresh, /updated under 10 minutes ago/);
  assert.match(at300.aging, /more than 10 minutes ago/);
  assert.match(at300.stale, /offline for more than 20 minutes/);
  const at60 = tierMsgs(60_000);
  assert.match(at60.fresh, /under 2 minutes ago/);
  assert.match(at60.stale, /more than 4 minutes/);
  assert.deepEqual(tierMsgs(null), {
    fresh: 'Board data is fresh — updated under 2 minutes ago.',
    aging: 'Board data is aging — last updated more than 2 minutes ago.',
    stale: 'Board data may be stale — the watcher has been offline for more than 5 minutes.',
  });
});

// FE-U13 — cadence copy forms, minute-rounded.
test('fmtCadence: long/short forms and rounding', () => {
  assert.deepEqual(fmtCadence(300_000), { long: '5 minutes', short: '~5 min' });
  assert.deepEqual(fmtCadence(60_000), { long: 'minute', short: '~1 min' });
  assert.deepEqual(fmtCadence(90_000), { long: '2 minutes', short: '~2 min' }); // minute-rounded
  assert.deepEqual(fmtCadence(null), { long: 'minute', short: '~1 min' }); // fallback words
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

// ================= round 2 — subscription panel pure exports =================

// FE-U14 — SUB_COPY is frozen; cadence templates rendered at 300 s equal
// DESIGN §7's locked literals byte-for-byte; the two TECH-added keys pinned.
test('SUB_COPY: frozen, and the 300 s renders equal the DESIGN-locked literals', () => {
  assert.ok(Object.isFrozen(SUB_COPY));
  const cad = fmtCadence(300_000);
  assert.equal(
    subCopy('panelHonesty', { cadLong: cad.long, cadShort: cad.short }),
    'Checks run about every 5 minutes — an alert can lag a restock by up to ~5 min.',
  );
  assert.equal(
    subCopy('noneIn', { cad: cad.long }),
    'Nothing in stock right now — the board checks about every 5 minutes. Subscribe to get a Telegram card the moment a plan comes back.',
  );
  // Null-cadence fallback renders the round-1 words.
  const fall = fmtCadence(null);
  assert.equal(
    subCopy('panelHonesty', { cadLong: fall.long, cadShort: fall.short }),
    'Checks run about every minute — an alert can lag a restock by up to ~1 min.',
  );
  // Static locked strings (DESIGN §7), byte-for-byte.
  assert.equal(SUB_COPY.ctaGlobal, '🔔 Get restock alerts');
  assert.equal(SUB_COPY.ctaCard, '🔔 Notify me');
  assert.equal(SUB_COPY.panelTitle, 'Restock alerts → your Telegram');
  assert.equal(SUB_COPY.pickerHint, "Plans in stock now alert on their next restock — after they've gone out and come back.");
  assert.equal(SUB_COPY.pickNone, 'pick at least one plan');
  assert.equal(SUB_COPY.submitLabel, 'Subscribe — send my confirmation ▸');
  assert.equal(SUB_COPY.sending, 'Sending confirmation to your bot…');
  assert.equal(SUB_COPY.successTitle, 'Check your Telegram');
  assert.equal(SUB_COPY.successBody, 'Your confirmation card just arrived — the same pipe delivers your restock digest.');
  assert.equal(SUB_COPY.mergedBody, 'Subscription updated — you now watch {n} {n|plan|plans}.');
  assert.equal(SUB_COPY.errTokenFormat, "That doesn't look like a bot token — it should look like 8123456789:AA… (46+ characters). Re-copy it from @BotFather.");
  assert.equal(SUB_COPY.errTokenRejected, 'Telegram rejected this token — re-copy it from @BotFather, or send /token there to reissue it.');
  assert.equal(SUB_COPY.errChatFormat, 'A chat id is just a number, like 521934882.');
  assert.equal(SUB_COPY.errChatNotFound, "Your bot can't message you yet — open it in Telegram, press Start, then retry.");
  assert.equal(SUB_COPY.errDiscover, "No chat found — open your new bot, press Start, then tap Find again. (A busy bot with a webhook can't be auto-read — paste the id manually.)");
  // Round-2 beta amendment: {t} carries the fmtRetry-humanized remainder —
  // deliberately diverges from DESIGN §7's raw-seconds {s}s literal.
  assert.equal(SUB_COPY.errRate, 'Too many attempts — try again in {t}.');
  assert.equal(SUB_COPY.bellAdded, '+ {name} added');
  assert.equal(SUB_COPY.errServer, 'Something broke on our side — nothing was saved. Try again in a minute.');
  assert.equal(SUB_COPY.mgNotFound, 'No subscription found for that token + chat id.');
  assert.equal(SUB_COPY.mgUpdated, 'Updated — you now watch {n} {n|plan|plans}.');
  assert.equal(SUB_COPY.mgGone, 'Unsubscribed. Your token and plan list were deleted.');
  assert.equal(SUB_COPY.privacy, "We store exactly three things: your bot token, your chat id, your plan list. No account, no email, no cookies. Your bot can only message people who pressed Start on it — that's you. Unsubscribe here anytime, or send /revoke to @BotFather — that kills the token instantly.");
  // The two TECH-added locked keys.
  assert.equal(SUB_COPY.errCap, "The board's subscriber list is full — nothing was saved. Try again later.");
  assert.equal(SUB_COPY.chatFound, "Found it — that's your chat id.");
  // Template rendering: {n}/{t}/{name} substitution, unknown vars left intact.
  assert.equal(subCopy('mergedBody', { n: 3 }), 'Subscription updated — you now watch 3 plans.');
  assert.equal(subCopy('errRate', { t: fmtRetry(40) }), 'Too many attempts — try again in 40s.');
  assert.equal(subCopy('bellAdded', { name: 'HKG.AN5.Pro.MINI' }), '+ HKG.AN5.Pro.MINI added');
});

// Round-2 fix (beta F44): every count-bearing SUB_COPY string pluralizes via
// the {n|singular|plural} choice token — "1 plan", never "1 plans".
test('subCopy pluralization matrix: mgUpdated and mergedBody at n = 0/1/2', () => {
  assert.equal(subCopy('mgUpdated', { n: 1 }), 'Updated — you now watch 1 plan.');
  assert.equal(subCopy('mgUpdated', { n: 2 }), 'Updated — you now watch 2 plans.');
  assert.equal(subCopy('mgUpdated', { n: 0 }), 'Updated — you now watch 0 plans.');
  assert.equal(subCopy('mergedBody', { n: 1 }), 'Subscription updated — you now watch 1 plan.');
  assert.equal(subCopy('mergedBody', { n: 2 }), 'Subscription updated — you now watch 2 plans.');
  assert.equal(subCopy('mergedBody', { n: 0 }), 'Subscription updated — you now watch 0 plans.');
  // String counts behave like numbers (server bodies arrive as JSON numbers,
  // but the choice token never depends on that).
  assert.equal(subCopy('mgUpdated', { n: '1' }), 'Updated — you now watch 1 plan.');
  // Unknown vars leave BOTH token forms intact — same contract as {vars}.
  assert.equal(subCopy('mgUpdated', {}), 'Updated — you now watch {n} {n|plan|plans}.');
  // No other count-bearing SUB_COPY string ships a hardcoded plural next to a
  // {placeholder} count — the matrix above covers every one that exists.
  for (const [k, v] of Object.entries(SUB_COPY)) {
    assert.ok(!/\{n\} plans?\b/.test(v), `unpluralized count template in SUB_COPY.${k}`);
  }
});

// ---- picker + plan index (FE-U16 / FE-U17 / FE-U18) -------------------------

const pickerState = () => ({
  datacenters: [
    { loc: 'lax', city: 'Los Angeles', flag: '🇺🇸', country: 'United States', generations: [
      { label: 'AS3', cpu: 'x', plans: [
        plan({ id: 'l1', name: 'LAX.AS3.Pro.TINY', price: '$10.90', status: 'out' }),
        plan({ id: 'l2', name: 'LAX.AS3.Pro.MINI', price: '$62.90', status: 'in', inSinceMs: NOW - MIN }),
      ]},
    ]},
    { loc: 'hkg', city: 'Hong Kong', flag: '🇭🇰', country: 'China', generations: [
      { label: 'AS3', cpu: 'x', plans: [
        plan({ id: 'h1', name: 'HKG.AS3.Pro.MICRO', price: '$179.90', status: 'checking' }),
      ]},
    ]},
  ],
});

test('pickerHTML: encounter order, checked set, per-DC select-all, status word', () => {
  const html = pickerHTML(pickerState(), new Set(['l2']), null);
  assert.match(html, /data-loc="lax"[\s\S]*data-loc="hkg"/); // snapshot encounter order
  assert.match(html, /class="pick" data-plan-id="l2" data-loc="lax" checked/);
  assert.doesNotMatch(html, /data-plan-id="l1" data-loc="lax" checked/);
  assert.match(html, /LAX\.AS3\.Pro\.TINY/);
  assert.match(html, /\$10\.90 <span class="sdot out"/); // price + status word per row
  assert.match(html, /sdot in/);
  assert.match(html, /sdot checking/);
  assert.match(html, /class="pick-all" data-loc="lax" aria-label="Select all Los Angeles plans"/);
  assert.match(html, /class="pick-all" data-loc="hkg"/); // tri-state select-all per group
  assert.match(html, /· 2</); // group plan count
});

test('pickerHTML: openLoc — one loc, all (true), or none (null)', () => {
  const state = pickerState();
  const one = pickerHTML(state, new Set(), 'hkg');
  assert.doesNotMatch(one, /data-loc="lax" open/);
  assert.match(one, /data-loc="hkg" open/);
  const all = pickerHTML(state, new Set(), true);
  assert.match(all, /data-loc="lax" open[\s\S]*data-loc="hkg" open/);
  const none = pickerHTML(state, new Set(), null);
  assert.doesNotMatch(none, / open>/);
});

test('planIndex: id → display record map; unknown id → undefined', () => {
  const map = planIndex(pickerState());
  assert.equal(map.size, 3);
  assert.deepEqual(map.get('h1'), {
    name: 'HKG.AS3.Pro.MICRO',
    city: 'Hong Kong',
    loc: 'hkg',
    price: '$179.90',
    period: 'mo',
    status: 'checking',
    deepLink: 'https://www.dmit.io/cart.php?a=add&pid=1',
  });
  assert.equal(map.get('nope'), undefined);
});

test('escaping: hostile plan names never survive as live markup in new builders', () => {
  const hostile = pickerState();
  hostile.datacenters[0].generations[0].plans[0].name = '<script>alert(1)</script>';
  const picker = pickerHTML(hostile, new Set(), null);
  assert.doesNotMatch(picker, /<script>/);
  assert.match(picker, /&lt;script&gt;/);
  const confirm = tgConfirmPreview([{ name: '<script>x</script>', city: 'Hong Kong' }], {});
  assert.doesNotMatch(confirm, /<script>/);
  assert.match(confirm, /&lt;script&gt;/);
  const digest = tgDigestPreview([{ name: '<b>“x”</b>', city: 'Tokyo', price: '$1', period: 'mo' }], { now: NOW });
  assert.doesNotMatch(digest, /<b>“/);
});

test('telegram previews: confirmation (merged variant) and digest shapes', () => {
  const plans = [
    { name: 'HKG.AS3.Pro.TINY', city: 'Hong Kong', price: '$39.90', period: 'mo' },
    { name: 'TYO.AS3.Pro.MICRO', city: 'Tokyo', price: '$189.90', period: 'mo' },
  ];
  const conf = tgConfirmPreview(plans, { cadenceMs: 300_000 });
  assert.match(conf, /✅ Subscribed — VPS Stock Watch/);
  assert.match(conf, /any of your <b>2 plans<\/b> restock/);
  assert.match(conf, /• HKG\.AS3\.Pro\.TINY — Hong Kong/);
  assert.match(conf, /checks run ~every 5 min · a plan re-alerts only after it goes out of stock again/);
  assert.match(conf, /manage: vps-stock\.daichenlab\.com\/\?manage=1/);
  assert.doesNotMatch(conf, /\$39\.90/); // a receipt, not a pitch — no prices
  const merged = tgConfirmPreview([plans[0]], { merged: true, cadenceMs: 300_000 });
  assert.match(merged, /🔄 Subscription updated/);
  assert.match(merged, /when your plan restocks/); // singular at n = 1
  const digest = tgDigestPreview([plans[0]], { cadenceMs: 300_000, now: NOW });
  assert.match(digest, /🟢 Restock — 1 of your plans is IN STOCK/); // singular form
  assert.match(digest, /<strong>HKG\.AS3\.Pro\.TINY<\/strong> — \$39\.90\/mo — Hong Kong/);
  assert.match(digest, /data can lag ~5 min/);
  assert.doesNotMatch(digest, /<a /); // previews never render live anchors
});

// ================= subscribe.js — transport, validation, routing =============

// Client format gates (TECH §fe-validate — the reconciled relaxed regex).
test('TOKEN_RE: 8–12 digit id, ≥30-char secret, trimmed-string semantics', () => {
  const secret30 = 'A'.repeat(30);
  assert.ok(TOKEN_RE.test(`12345678:${secret30}`)); // 8-digit id + 30-char secret
  assert.ok(TOKEN_RE.test(`123456789012:${secret30}`)); // 12-digit id edge passes
  assert.ok(TOKEN_RE.test(`8000000001:TESTSENTINELTOKENxxxxxxxxxxxxxxxx`)); // sentinel shape
  assert.ok(TOKEN_RE.test(`12345678:${'a-_'.repeat(12)}`)); // secret alphabet incl. - _
  assert.ok(!TOKEN_RE.test(`1234567:${secret30}`)); // 7-digit id
  assert.ok(!TOKEN_RE.test(`1234567890123:${secret30}`)); // 13-digit id
  assert.ok(!TOKEN_RE.test(`12345678:${'A'.repeat(29)}`)); // 29-char secret
  assert.ok(!TOKEN_RE.test(`12345678${secret30}`)); // missing colon
  assert.ok(!TOKEN_RE.test(''));
});

test('CHAT_RE: chat id is a digit string; the leading minus is real', () => {
  assert.ok(CHAT_RE.test('521934882'));
  assert.ok(CHAT_RE.test('-100123456789')); // negative group id
  assert.ok(CHAT_RE.test('5300000000123456789')); // int64 beyond 2^53, as a string
  assert.ok(!CHAT_RE.test('12a'));
  assert.ok(!CHAT_RE.test(''));
  assert.ok(!CHAT_RE.test('1.5'));
});

test('parseRetryAfter: integer seconds; absent/unparseable/non-positive → 60', () => {
  assert.equal(parseRetryAfter('40'), 40);
  assert.equal(parseRetryAfter(' 25 '), 25);
  assert.equal(parseRetryAfter(null), 60);
  assert.equal(parseRetryAfter('soon'), 60);
  assert.equal(parseRetryAfter('0'), 60);
  assert.equal(parseRetryAfter('-3'), 60);
});

// Round-2 beta finding: 429 banners tick a HUMANIZED remainder at 1 Hz.
test('fmtRetry: humanized remainder — seconds, zero-padded m/s, hour form, clamped', () => {
  assert.equal(fmtRetry(45), '45s');
  assert.equal(fmtRetry(59), '59s');
  assert.equal(fmtRetry(60), '1m 00s');
  assert.equal(fmtRetry(185), '3m 05s');
  assert.equal(fmtRetry(3410), '56m 50s'); // the beta report's raw "3410s"
  assert.equal(fmtRetry(3661), '1h 01m 01s');
  assert.equal(fmtRetry(0), '0s');
  assert.equal(fmtRetry(-3), '0s'); // never negative
  assert.equal(fmtRetry(1.9), '1s'); // floored, no fractional seconds
});

test('rateState: ticking banner text until the deadline; expired AT it — same gate as updateTray', () => {
  const D = NOW + 90_000; // Retry-After: 90
  assert.deepEqual(rateState(D, NOW), { expired: false, text: 'Too many attempts — try again in 1m 30s.' });
  assert.deepEqual(rateState(D, NOW + 1000), { expired: false, text: 'Too many attempts — try again in 1m 29s.' }); // 1 Hz tick observable
  assert.deepEqual(rateState(D, D - 1000), { expired: false, text: 'Too many attempts — try again in 1s.' });
  assert.deepEqual(rateState(D, D - 1), { expired: false, text: 'Too many attempts — try again in 1s.' }); // ceil — never shows 0s while gated
  // The deadline→re-enable transition: banner clears and the submit gate
  // (deadlines[key] > now, i.e. NOT expired) reopens at the same instant.
  assert.deepEqual(rateState(D, D), { expired: true, text: null });
  assert.deepEqual(rateState(D, D + 5000), { expired: true, text: null });
  assert.deepEqual(rateState(0, NOW), { expired: true, text: null }); // no deadline stored ⇒ never gated
});

test('api(): JSON POST with 12 s abort, no-store, status-only result — never throws', async () => {
  assert.equal(API_TIMEOUT_MS, 12_000);
  const calls = [];
  const fakeRes = {
    status: 429,
    headers: { get: (k) => (k === 'retry-after' ? '40' : null) },
    json: async () => ({ reason: 'cap', extra: 1 }),
  };
  const res = await api('/api/subscribe', { token: 't', chatId: '1', planIds: ['a'] }, async (url, init) => {
    calls.push({ url, init });
    return fakeRes;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/subscribe');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.ok(calls[0].init.signal instanceof AbortSignal); // 12 s timeout armed
  assert.deepEqual(JSON.parse(calls[0].init.body), { token: 't', chatId: '1', planIds: ['a'] });
  assert.deepEqual(res, { status: 429, reason: 'cap', retryAfter: 40, body: { reason: 'cap', extra: 1 } });
});

test('api(): empty/invalid body is fine; network/timeout → status 0, never a throw', async () => {
  const noBody = await api('/api/chatid', { token: 't' }, async () => ({
    status: 200,
    headers: { get: () => null },
    json: async () => {
      throw new Error('empty');
    },
  }));
  assert.deepEqual(noBody, { status: 200, reason: null, retryAfter: 60, body: null });
  const dead = await api('/api/chatid', { token: 't' }, async () => {
    throw new Error('network down');
  });
  assert.deepEqual(dead, { status: 0, reason: null, retryAfter: null, body: null });
});

// The complete error-code → UI map (TECH §fe-api) — tests pin every row.
test('routeOutcome: subscribe rows', () => {
  assert.deepEqual(routeOutcome('subscribe', { status: 200 }), { ui: 'success' });
  assert.deepEqual(routeOutcome('subscribe', { status: 422, reason: 'token_rejected' }), { ui: 'field', field: 'token', copy: 'errTokenRejected' });
  assert.deepEqual(routeOutcome('subscribe', { status: 422, reason: 'chat_not_found' }), { ui: 'field', field: 'chat', copy: 'errChatNotFound' });
  assert.deepEqual(routeOutcome('subscribe', { status: 422, reason: 'brand_new_reason' }), { ui: 'banner', copy: 'errServer' }); // unknown reasons fall back
  assert.deepEqual(routeOutcome('subscribe', { status: 429, reason: 'cap' }), { ui: 'banner', copy: 'errCap' }); // no countdown at the cap
  assert.deepEqual(routeOutcome('subscribe', { status: 429 }), { ui: 'banner', copy: 'errRate', countdown: true });
  for (const status of [400, 413, 500, 502, 503, 0, 418]) {
    assert.deepEqual(routeOutcome('subscribe', { status }), { ui: 'banner', copy: 'errServer' }, String(status));
  }
});

test('routeOutcome: chatid rows — submit path never touched by discovery errors', () => {
  assert.deepEqual(routeOutcome('chatid', { status: 200 }), { ui: 'fill', copy: 'chatFound' });
  assert.deepEqual(routeOutcome('chatid', { status: 422, reason: 'token_rejected' }), { ui: 'field', field: 'token', copy: 'errTokenRejected' });
  assert.deepEqual(routeOutcome('chatid', { status: 422, reason: 'no_chat' }), { ui: 'status', copy: 'errDiscover' });
  assert.deepEqual(routeOutcome('chatid', { status: 429 }), { ui: 'status', copy: 'errRate', countdown: true }); // status line, never the banner
  assert.deepEqual(routeOutcome('chatid', { status: 502 }), { ui: 'status', copy: 'errServer' });
  assert.deepEqual(routeOutcome('chatid', { status: 0 }), { ui: 'status', copy: 'errServer' });
});

test('routeOutcome: manage rows — uniform not-found, idempotent delete', () => {
  assert.deepEqual(routeOutcome('lookup', { status: 200 }), { ui: 'loaded' });
  assert.deepEqual(routeOutcome('lookup', { status: 404 }), { ui: 'notFound' });
  assert.deepEqual(routeOutcome('lookup', { status: 429 }), { ui: 'banner', copy: 'errRate', countdown: true });
  assert.deepEqual(routeOutcome('lookup', { status: 500 }), { ui: 'banner', copy: 'errServer' });
  assert.deepEqual(routeOutcome('update', { status: 200 }), { ui: 'done', copy: 'mgUpdated' });
  assert.deepEqual(routeOutcome('update', { status: 404 }), { ui: 'notFound' }); // row vanished → back to IDLE
  assert.deepEqual(routeOutcome('update', { status: 422, reason: 'token_rejected' }), { ui: 'banner', copy: 'errTokenRejected' }); // stays LOADED
  assert.deepEqual(routeOutcome('update', { status: 422, reason: 'chat_not_found' }), { ui: 'banner', copy: 'errChatNotFound' });
  assert.deepEqual(routeOutcome('update', { status: 429 }), { ui: 'banner', copy: 'errRate', countdown: true });
  assert.deepEqual(routeOutcome('delete', { status: 200 }), { ui: 'done', copy: 'mgGone' });
  assert.deepEqual(routeOutcome('delete', { status: 404 }), { ui: 'done', copy: 'mgGone' }); // goal state reached
  assert.deepEqual(routeOutcome('delete', { status: 429 }), { ui: 'banner', copy: 'errRate', countdown: true });
  assert.deepEqual(routeOutcome('delete', { status: 0 }), { ui: 'banner', copy: 'errServer' });
});

// ============ round-2 fix — manage deep-link + update safety (beta F44) ======
// The regression: ?manage=1 opened the panel at module boot, BEFORE the first
// snapshot, so planMap was empty; showLoaded filtered the saved planIds
// through that empty map → zero pre-checked rows while the summary still said
// "You watch N plans" — and Update then silently dropped every saved plan.

test('manageLoadModel: saved ids pre-check verbatim once a snapshot exists', () => {
  const snap = { state: pickerState(), receivedAt: NOW };
  const m = manageLoadModel(['l2', 'h1'], snap);
  assert.equal(m.ready, true);
  assert.deepEqual([...m.checked].sort(), ['h1', 'l2']);
  assert.equal(m.summary, 'You watch 2 plans. Edit the list, or clear everything to unsubscribe.');
  // The pre-check actually lands in the rendered rows (the regression proof).
  const html = pickerHTML(snap.state, m.checked, true);
  assert.match(html, /data-plan-id="l2" data-loc="lax" checked/);
  assert.match(html, /data-plan-id="h1" data-loc="hkg" checked/);
  assert.doesNotMatch(html, /data-plan-id="l1" data-loc="lax" checked/);
  // Saved ids are NEVER filtered through a plan index — an id missing from the
  // snapshot stays in the checked set (harmless to render, and updateDraft
  // preserves it); silent narrowing is what caused the data loss.
  const ghost = manageLoadModel(['l2', 'ghost'], snap);
  assert.deepEqual([...ghost.checked].sort(), ['ghost', 'l2']);
});

test('manageLoadModel: no snapshot → loading state, summary still speaks the true count', () => {
  for (const snap of [null, undefined, {}, { state: null }]) {
    const m = manageLoadModel(['l1', 'l2', 'h1'], snap);
    assert.equal(m.ready, false, String(snap));
    assert.deepEqual([...m.checked].sort(), ['h1', 'l1', 'l2']); // nothing lost while loading
    assert.equal(m.summary, 'You watch 3 plans. Edit the list, or clear everything to unsubscribe.');
  }
  // Summary count pluralizes (same F44 sweep as SUB_COPY).
  assert.equal(manageLoadModel(['l1'], null).summary, 'You watch 1 plan. Edit the list, or clear everything to unsubscribe.');
});

test('updateDraft: an Update can never drop a saved-but-unrendered plan', () => {
  // Picker still loading (zero rendered rows): the draft IS the saved set.
  assert.deepEqual(updateDraft([], [], ['a', 'b']), ['a', 'b']);
  // A saved plan that never rendered as a row survives; a rendered-and-
  // unchecked row is an explicit uncheck and drops.
  assert.deepEqual(updateDraft(['a'], ['a', 'b'], ['a', 'b', 'c']), ['a', 'c']);
  // Fully rendered picker, all explicitly unchecked → empty draft (the
  // unsubscribe path stays reachable — nothing is resurrected).
  assert.deepEqual(updateDraft([], ['a', 'b'], ['a', 'b']), []);
  // Newly checked rows join; no duplicates when saved ids are also checked.
  assert.deepEqual(updateDraft(['a', 'x'], ['a', 'b', 'x'], ['a', 'c']), ['a', 'x', 'c']);
  // Null/absent saved set (defensive) → the visible checks alone.
  assert.deepEqual(updateDraft(['a'], ['a'], null), ['a']);
  assert.deepEqual(updateDraft(['a'], ['a'], undefined), ['a']);
});

// ================= static read-only audit — rewritten, never deleted =========
// Round-1's "no method:/POST in board-server/public/" becomes an allowlist
// (TECH §10 deliberate repeal): mutating fetches exist in exactly one file,
// js/subscribe.js, and target only the five enumerated same-origin routes;
// no storage APIs anywhere in the shipped bundle (SEC-8).

const bundleFiles = () => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(PUB);
  return files;
};

test('static audit: "method:" appears in js/subscribe.js only (the one POST client)', () => {
  const hits = bundleFiles().filter((f) => /method:/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits.map((f) => f.slice(PUB.length + 1)), ['js/subscribe.js']);
});

test('static audit: subscribe.js POSTs only the five enumerated same-origin routes', () => {
  const src = readFileSync(join(PUB, 'js', 'subscribe.js'), 'utf8');
  const routes = [...src.matchAll(/["'`](\/api\/[a-z/]+)["'`]/g)].map((m) => m[1]);
  assert.ok(routes.length >= 5, 'found the route literals');
  const allow = new Set(['/api/subscribe', '/api/chatid', '/api/subscription/lookup', '/api/subscription/update', '/api/subscription/delete']);
  for (const r of routes) assert.ok(allow.has(r), `unexpected route ${r}`);
  assert.deepEqual([...new Set(routes)].sort(), [...allow].sort()); // and all five are used
  assert.ok(!/console\./.test(src), 'no console output in the credential module');
});

test('static audit: no storage APIs or side channels anywhere in the bundle', () => {
  const banned = new RegExp(
    ['localStorage', 'sessionStorage', 'document\\.cookie', 'indexedDB', 'EventSource', 'new Audio', 'Notification\\b', '\\.dmit-watch'].join('|'),
  );
  for (const f of bundleFiles()) {
    assert.ok(!banned.test(readFileSync(f, 'utf8')), `banned API reference in ${f}`);
  }
});

test('static audit: board.js stays read-only and exports getLatest', () => {
  const src = readFileSync(join(PUB, 'js', 'board.js'), 'utf8');
  assert.match(src, /export function getLatest/);
  assert.match(src, /export function firstSnapshot/); // one-shot F44 deep-link hook
  assert.doesNotMatch(src, /method:/); // the poll loop never mutates
  assert.doesNotMatch(src, /no POST anywhere/); // header claim repealed, scoped
  assert.match(src, /mutations live in js\/subscribe\.js/); // scoped repeal claim present
});

// ---- panel skeleton (index.html ships it statically — zero CLS) -------------

test('index.html: panel skeleton carries every binding id from DESIGN §12 / TECH §fe-panel', () => {
  const html = readFileSync(join(PUB, 'index.html'), 'utf8');
  for (const id of [
    'pageShell', 'alertsCta', 'subOverlay', 'subPanel', 'subTitle', 'subHonesty', 'subClose',
    'tabSubscribe', 'tabManage', 'paneSubscribe', 'paneManage', 'step1', 'planPicker', 'step2',
    'subForm', 'fTok', 'fldToken', 'fTokErr', 'fChat', 'fldChat', 'fChatErr', 'findChat',
    'subBanner', 'subSuccess', 'okTitle', 'okBody', 'okList', 'okBubble', 'okDigestBubble',
    'mgAuth', 'mgForm', 'mTok', 'mgToken', 'mTokErr', 'mChat', 'mgChat', 'mChatErr',
    'mgNotFound', 'mgLoaded', 'mgSummary', 'mgPicker', 'mgConfirm', 'mgConfirmYes', 'mgConfirmNo',
    'mgDoneCard', 'mgBanner', 'subStatus', 'pickCountSr', 'pickTray', 'pickCount', 'pickHint',
    'backTo1', 'toStep2', 'subSubmit', 'subDone', 'mgLoad', 'mgUpdate', 'mgUnsub', 'mgClose',
    'cadExplainer', 'cadFooter', 'addChip',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing id ${id}`);
  }
  // Token inputs are type=password (round-2 hygiene fix): a pasted real token
  // never sits readable on screen or in screenshots. Chat id fields stay text.
  assert.match(html, /<input id="fldToken" type="password" autocomplete="off" spellcheck="false"/);
  assert.match(html, /<input id="mgToken" type="password" autocomplete="off" spellcheck="false"/);
  assert.doesNotMatch(html, /id="(?:fldToken|mgToken)" type="text"/);
  assert.match(html, /<input id="fldChat" inputmode="numeric" autocomplete="off"/);
  assert.match(html, /<input id="mgChat" inputmode="numeric" autocomplete="off"/);
  assert.doesNotMatch(html, /id="(?:fldChat|mgChat)" type="password"/);
  // ONE status region named subStatus, role=status (both tabs share it).
  assert.equal([...html.matchAll(/id="subStatus"/g)].length, 1);
  assert.match(html, /id="subStatus" role="status" aria-live="polite"/);
  // Dialog semantics + both module entries; no inline handlers (CSP survives).
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="subTitle"/);
  assert.match(html, /<script type="module" src="js\/board\.js"><\/script>\s*<script type="module" src="js\/subscribe\.js"><\/script>/);
  assert.doesNotMatch(html, /\son[a-z]+="/i);
  // Locked panel copy in the skeleton.
  assert.ok(html.includes(SUB_COPY.panelTitle));
  assert.ok(html.includes(SUB_COPY.pickerHint));
  assert.ok(html.includes(SUB_COPY.ctaGlobal));
  assert.ok(html.includes(SUB_COPY.mgNotFound));
  assert.ok(html.includes(SUB_COPY.submitLabel));
  // BotFather step names its two prompts (round-2 beta copy fix), one sentence.
  assert.ok(html.includes("and follow the two prompts (a name, then a username ending in 'bot')."));
});
