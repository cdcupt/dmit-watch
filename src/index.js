// Entry point — the single supervised Node process (TECH §01, §07).
// Boots the whole stack: validate config + secrets (fail fast), open + seed the
// SQLite store, build the CDP-attached watcher (it talks to the dedicated Chrome
// on :9444), build the Telegram notifier, wire them through the scheduler, and
// run until SIGINT/SIGTERM. launchd KeepAlive + caffeinate live in scripts/.
//
// This file does NO detection or alerting logic itself — it only assembles the
// pieces (all unit/integration-tested in isolation) and owns process lifecycle.

import { loadWatchlist, loadSecrets } from './config.js';
import { openStore } from './store.js';
import { createWatcher } from './watcher.js';
import { createTelegramNotifier } from './telegram.js';
import { createScheduler } from './scheduler.js';
import { createPanelServer } from './server.js';
import { DB_FILE, SECRETS_FILE, WATCHLIST_FILE } from './paths.js';

// Process-level guards: this is an ALWAYS-ON monitor. A stray rejected promise or
// an uncaught error from any subsystem (an HTTP request, a watcher poll, a Telegram
// send) must be logged and SWALLOWED — never allowed to terminate the process, or
// a restock could be missed during the outage. We deliberately do NOT exit here;
// the scheduler + watcher + panel keep running. Real fatal startup failures are
// handled by main().catch() below (before the loop is even up).
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  console.error(`[index] unhandledRejection (logged, staying up): ${msg}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[index] uncaughtException (logged, staying up): ${err?.stack ?? err}`);
});

async function main() {
  // 1) Boundary validation — fail fast with actionable messages.
  const watchlist = loadWatchlist();
  const secrets = loadSecrets({ required: true }); // throws if creds absent
  console.log(`[index] watchlist ok — ${watchlist.plans.length} plans / ${watchlist.families.length} families`);
  console.log(`[index] secrets ok — loaded from ${SECRETS_FILE} (values not logged)`);

  // 2) Store: open + reconcile plans from the watchlist (idempotent, no migration).
  const store = openStore();
  const seeded = store.seedFromWatchlist(watchlist);
  console.log(`[index] db ${DB_FILE} — ${seeded.plansInserted} inserted, ${seeded.plansUpdated} updated`);

  // 3) Watcher (default page source = CDP attach to the dedicated Chrome).
  const watcher = createWatcher({ store, watchlist });

  // 4) Telegram notifier (real fetch, logs each send to telegram_log).
  const notifier = createTelegramNotifier({ secrets, store });

  // 5) Localhost panel server (HTTP + SSE) — its broadcast hook is the fan-out the
  //    scheduler pushes every watcher event into, so the panel sees edges live.
  const server = createPanelServer({ store, watchlist, watchlistPath: WATCHLIST_FILE });
  const port = await server.start();

  // 6) Wire + run. The scheduler routes watcher events → Telegram AND the panel.
  const scheduler = createScheduler({ watcher, notifier, store, broadcast: server.broadcast });
  scheduler.start();
  console.log(`[index] running — panel at http://127.0.0.1:${port} — Ctrl-C to stop`);

  // 6) Graceful shutdown.
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[index] ${signal} — shutting down`);
    try {
      await scheduler.stop();
      await server.stop();
      store.close();
    } catch (err) {
      console.error(`[index] shutdown error: ${err.message}`);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[index] fatal: ${err.message}`);
  process.exit(1);
});
