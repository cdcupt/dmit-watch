#!/usr/bin/env node
// Smoke: boot the localhost panel server against an in-memory store seeded with
// the 33 Premium plans (one flipped IN to exercise the in-stock path + alarm),
// then hit the REST surface and assert the data contract — no live store needed.
//
//   npm run smoke:server

import { createPanelServer } from '../src/server.js';
import { openStore } from '../src/store.js';
import { loadWatchlist } from '../src/config.js';

const line = () => console.log('─'.repeat(64));
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function main() {
  const watchlist = loadWatchlist();
  const store = openStore(':memory:');
  store.seedFromWatchlist(watchlist);
  store.touchHeartbeat({ chromeSession: 'UP' });

  // Flip one plan IN so /api/state shows the in-stock grouping + counts.in.
  const inId = 'lax-an4-medium';
  store.setPlanState(inId, { status: 'IN', lastKnown: 'IN', lastChecked: Date.now(), lastChange: Date.now() });

  const server = createPanelServer({ store, watchlist, port: 0, logger: { log() {}, warn() {}, error() {} } });
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  console.log(`server up on ${base}`);
  line();

  const j = async (p) => {
    const r = await fetch(base + p);
    must(r.ok, `${p} → ${r.status}`);
    return r.json();
  };

  // ---- /api/state --------------------------------------------------------
  const state = await j('/api/state');
  const flatPlans = state.datacenters.flatMap((dc) => dc.generations.flatMap((g) => g.plans));
  console.log(`/api/state: ${state.datacenters.length} datacenters · ${flatPlans.length} plans`);
  console.log(`  counts: ${JSON.stringify(state.counts)}`);
  must(flatPlans.length === 33, `expected 33 plans, got ${flatPlans.length}`);
  must(state.counts.total === 33, `counts.total should be 33, got ${state.counts.total}`);
  must(state.counts.in === 1, `counts.in should be 1, got ${state.counts.in}`);
  must(state.counts.waiting === 32, `counts.waiting should be 32, got ${state.counts.waiting}`);
  must(state.counts.byLoc.lax === 16 && state.counts.byLoc.hkg === 10 && state.counts.byLoc.tyo === 7, 'byLoc mismatch');
  must(state.counts.byGen.as3 === 18 && state.counts.byGen.an4 === 5 && state.counts.byGen.an5 === 10, 'byGen mismatch');
  must(state.datacenters[0].loc === 'lax' && state.datacenters[2].loc === 'tyo', 'datacenter order should be LAX→…→TYO');
  const inPlan = flatPlans.find((p) => p.id === inId);
  must(inPlan && inPlan.status === 'in' && inPlan.deepLink.includes('cart.php'), 'flipped plan should be in-stock w/ deep link');

  // ---- /api/health -------------------------------------------------------
  const health = await j('/api/health');
  console.log(`/api/health: ${health.families.length} families · chrome=${health.chrome.state} · status=${health.scheduler.status}`);
  must(health.families.length === 6, `expected 6 families, got ${health.families.length}`);
  must(Array.isArray(health.telegram), 'health.telegram must be an array');

  // ---- /api/history ------------------------------------------------------
  const history = await j('/api/history');
  must(Array.isArray(history.transitions), 'history.transitions must be an array');

  // ---- panel HTML + assets ----------------------------------------------
  const html = await (await fetch(base + '/')).text();
  must(/<title>DMIT Restock Watch/.test(html), 'index.html should serve the panel title');
  must(/id="view-panel"/.test(html) && /\/js\/app\.js/.test(html), 'index.html should mount the panel + module');
  const appJs = await fetch(base + '/js/app.js');
  must(appJs.ok && /javascript/.test(appJs.headers.get('content-type') || ''), '/js/app.js should serve as JS');
  const css = await fetch(base + '/css/tokens.css');
  must(css.ok && /css/.test(css.headers.get('content-type') || ''), '/css/tokens.css should serve as CSS');
  console.log('panel HTML + /js/app.js + /css/tokens.css all serve with correct content-type');

  // ---- path-traversal guard ---------------------------------------------
  const trav = await fetch(base + '/../src/server.js');
  must(trav.status === 404 || trav.status === 403, 'path traversal must be blocked');

  await server.stop();
  store.close();
  line();
  console.log('OK: localhost server serves /api/state (33 plans, counts), /api/health, /api/history, and the panel.');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
