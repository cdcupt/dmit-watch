#!/usr/bin/env node
// Smoke: exercise the PURE detector + the watcher end-to-end against fixtures —
// no live store, no Chrome. Prints per-plan statuses for the all-OUT and the
// synthetic-orderable cart pages, a simulated OUT→IN edge, and the blind net.
//
//   npm run smoke

import { classifyFamily, computeEdges, STOCK } from '../src/detect.js';
import { createWatcher } from '../src/watcher.js';
import { openStore } from '../src/store.js';
import { loadWatchlist } from '../src/config.js';
import { readFixture, makeFixtureSource } from '../test/helpers.js';

const FAMILY_KEY = 'lax/an5';
const line = () => console.log('─'.repeat(64));

function freshStore(watchlist) {
  const store = openStore(':memory:');
  store.seedFromWatchlist(watchlist);
  return store;
}

function printStatuses(label, detection) {
  console.log(`\n${label}  (markersPresent=${detection.markersPresent}, controlOut=${detection.controlOutCount})`);
  for (const r of detection.results) {
    const tag = r.stock === STOCK.IN ? '🟢' : r.stock === STOCK.OUT ? '⚪️' : '⚠️';
    console.log(`  ${tag} ${r.name.padEnd(22)} ${r.stock.padEnd(8)} ${r.reason}`);
  }
}

async function main() {
  const watchlist = loadWatchlist();
  const family = watchlist.families.find((f) => f.key === FAMILY_KEY);
  const plans = watchlist.plans.filter((p) => p.family === FAMILY_KEY);
  const K = watchlist.settings.controlGroupMinK ?? 3;

  console.log(`dmit-watch detection smoke — family ${FAMILY_KEY} (${plans.length} plans, control K=${K})`);

  // 1) PURE classification over both fixtures.
  line();
  console.log('1. PURE classifyFamily() over fixtures');
  const allOut = classifyFamily({ pageText: readFixture('all-out.txt'), family, plans, controlGroupMinK: K });
  const orderable = classifyFamily({ pageText: readFixture('orderable.synthetic.txt'), family, plans, controlGroupMinK: K });
  printStatuses('all-out.txt', allOut);
  printStatuses('orderable.synthetic.txt', orderable);

  // 2) Simulated OUT→IN edge: stored = all OUT + armed, then the orderable read.
  line();
  console.log('2. Edge engine — stored all-OUT+armed vs the orderable read');
  const storedById = Object.fromEntries(
    plans.map((p) => [p.id, { last_known: STOCK.OUT, armed: 1, last_change: null }]),
  );
  const edges = computeEdges(orderable.results, storedById, { now: Date.now(), cooldownMs: 0 });
  for (const e of edges.fired) {
    console.log(`  🔔 FIRE  ${e.name}  ${e.transition.from}→${e.transition.to}  (armed→disarmed)`);
  }
  console.log(`  fired=${edges.fired.length}  rearmed=${edges.rearmed.length}  (expected fired=1)`);
  if (edges.fired.length !== 1) throw new Error(`expected exactly 1 fired edge, got ${edges.fired.length}`);

  // 3) Watcher end-to-end against a fixture source (no Chrome): OUT cycle then restock.
  line();
  console.log('3. Watcher pollFamily() end-to-end (fixture source, in-memory DB)');
  const store = freshStore(watchlist);
  let pageText = readFixture('all-out.txt');
  const source = makeFixtureSource({ [FAMILY_KEY]: () => ({ ok: true, status: 200, pageText }) });
  const watcher = createWatcher({ store, watchlist, pageSource: source });
  watcher.on('edge', ({ plan, deepLink }) => console.log(`  📣 edge event: ${plan.name} IN → ${deepLink}`));
  watcher.on('rearm', ({ plan, durationInStock }) => console.log(`  🔁 rearm event: ${plan.name} (in stock ${durationInStock ?? '?'}s)`));

  const s1 = await watcher.pollFamily(FAMILY_KEY);
  console.log(`  cycle 1 (all OUT): fired=${JSON.stringify(s1.fired)} statuses=${JSON.stringify(s1.statuses)}`);
  pageText = readFixture('orderable.synthetic.txt'); // a restock appears
  const s2 = await watcher.pollFamily(FAMILY_KEY);
  console.log(`  cycle 2 (restock): fired=${JSON.stringify(s2.fired)}`);
  const mini = store.getPlan('lax-an5-mini');
  console.log(`  DB now: lax-an5-mini status=${mini.status} last_known=${mini.last_known} armed=${mini.armed}`);
  console.log(`  transitions logged: ${store.transitionsForPlan('lax-an5-mini').length}`);
  const s3 = await watcher.pollFamily(FAMILY_KEY); // still IN → no re-alert
  console.log(`  cycle 3 (still IN): fired=${JSON.stringify(s3.fired)}  (expected [] — disarmed)`);

  // 4) Blind-watcher net: persistent CF challenge for ≥ blindCycles.
  line();
  console.log(`4. Blind-watcher net — CF challenge for ${watchlist.settings.blindCycles} cycles`);
  const store2 = freshStore(watchlist);
  const cfSource = makeFixtureSource({ [FAMILY_KEY]: () => ({ ok: true, status: 200, pageText: readFixture('cf-challenge.txt') }) });
  const watcher2 = createWatcher({ store: store2, watchlist, pageSource: cfSource });
  let blindFired = null;
  watcher2.on('blind', (ev) => { blindFired = ev; });
  for (let i = 1; i <= watchlist.settings.blindCycles; i++) {
    const s = await watcher2.pollFamily(FAMILY_KEY);
    console.log(`  cycle ${i}: blind=${s.blind} reasons=${JSON.stringify(s.blindReasons)}`);
  }
  if (!blindFired) throw new Error('blind-watcher alert never fired');
  console.log(`  ⚠️ blind event fired: reasons=${JSON.stringify(blindFired.reasons)}`);

  store.close();
  store2.close();
  line();
  console.log('OK: detection + edge + watcher + blind-watcher net all verified against fixtures.');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
