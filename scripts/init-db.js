#!/usr/bin/env node
// Smoke / bootstrap: open (create) the SQLite store, seed the 32 watched plans
// from config/watchlist.json, then read them back and print a summary.
//
//   npm run init-db
//
// Honors DMIT_WATCH_DB to target a scratch file instead of ~/.dmit-watch.

import { loadWatchlist } from '../src/config.js';
import { openStore } from '../src/store.js';
import { DB_FILE } from '../src/paths.js';

function main() {
  const watchlist = loadWatchlist();
  const store = openStore();

  const seeded = store.seedFromWatchlist(watchlist);
  const plans = store.allPlans();
  const families = store.allFamilyHealth();

  const byLoc = {};
  const byGen = {};
  for (const p of plans) {
    byLoc[p.loc] = (byLoc[p.loc] ?? 0) + 1;
    byGen[p.gen] = (byGen[p.gen] ?? 0) + 1;
  }

  console.log(`DB:            ${DB_FILE}`);
  console.log(`families:      ${families.length}  (${families.map((f) => f.family).join(', ')})`);
  console.log(`plans seeded:  ${seeded.plansInserted} inserted, ${seeded.plansUpdated} updated`);
  console.log(`plans total:   ${plans.length}`);
  console.log(`  by location: ${JSON.stringify(byLoc)}`);
  console.log(`  by gen:      ${JSON.stringify(byGen)}`);
  console.log('sample rows (read back):');
  for (const p of [plans[0], plans[Math.floor(plans.length / 2)], plans.at(-1)]) {
    console.log(`  ${p.id.padEnd(18)} ${p.name.padEnd(22)} ${p.price.padStart(9)}  status=${p.status} last_known=${p.last_known} armed=${p.armed}`);
  }

  store.touchHeartbeat({ chromeSession: 'UNKNOWN' });
  const hb = store.getHeartbeat();
  console.log(`heartbeat:     tick=${hb.tick_ts} uptime_started=${hb.uptime_started} chrome=${hb.chrome_session}`);

  store.close();

  if (plans.length !== 32) {
    console.error(`\nFAIL: expected 32 plans, got ${plans.length}`);
    process.exit(1);
  }
  console.log('\nOK: store created + 32 plans seeded + read back.');
}

main();
