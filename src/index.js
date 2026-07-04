// Entry point — the single supervised Node process (TECH §01, §07).
// Boots the whole stack: validate config (fail fast), open + seed the SQLite
// store, build the CDP-attached watcher (it talks to the dedicated Chrome on
// :9444), wire the notifier (real Telegram when creds exist, else a no-op —
// Telegram is optional in the full-remote deployment) and the optional public
// board publisher, connect them through the scheduler, and run until
// SIGINT/SIGTERM. launchd KeepAlive + caffeinate live in scripts/.
//
// This file does NO detection or alerting logic itself — it only assembles the
// pieces (all unit/integration-tested in isolation) and owns process lifecycle.
// The two wire* helpers are exported as the composition seams the tests use;
// main() runs only when this file is the executed entry script.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadWatchlist, loadSecrets, loadPushConfig } from './config.js';
import { openStore } from './store.js';
import { createWatcher } from './watcher.js';
import { createTelegramNotifier } from './telegram.js';
import { createPublisher } from './publisher.js';
import { createScheduler } from './scheduler.js';
import { createPanelServer } from './server.js';
import { DB_FILE, SECRETS_FILE, WATCHLIST_FILE } from './paths.js';

/**
 * Alerting seam: a real Telegram notifier when creds exist, else a same-shaped
 * no-op (notifyEdge/notifyBlind resolve, record nothing) so the scheduler
 * wiring is identical either way. Without creds, blind escalations and restock
 * edges stay panel/board-only — exactly one log line says so.
 * @param {{ secrets: object|null, store?: object, logger?: object, createNotifier?: Function }} opts
 */
export function wireNotifier({ secrets, store, logger = console, createNotifier = createTelegramNotifier }) {
  if (!secrets) {
    logger?.log?.('[index] telegram: disabled (no credentials)');
    const resolved = () => Promise.resolve({ ok: true, noop: true });
    return { noop: true, notifyEdge: resolved, notifyBlind: resolved };
  }
  logger?.log?.(`[index] secrets ok — loaded from ${SECRETS_FILE} (values not logged)`);
  return createNotifier({ secrets, store });
}

/**
 * Publisher seam: construct the push publisher from loadPushConfig() output and
 * log exactly one boot line — the URL's origin only, never the token, never the
 * full endpoint path.
 * @param {{ config: object|null, getWatchlist: Function, store: object, logger?: object, create?: Function }} opts
 */
export function wirePublisher({ config, getWatchlist, store, logger = console, create = createPublisher }) {
  const publisher = create({ config, getWatchlist, store, logger });
  if (publisher.enabled) {
    logger?.log?.(`[index] push: enabled -> ${new URL(config.url).origin}`);
  } else {
    logger?.log?.('[index] push: disabled (not configured)');
  }
  return publisher;
}

async function main() {
  // 1) Boundary validation — the watchlist still fails fast; Telegram creds
  //    are optional (returns null when absent → no-op notifier below).
  const watchlist = loadWatchlist();
  const secrets = loadSecrets({ required: false });
  console.log(`[index] watchlist ok — ${watchlist.plans.length} plans / ${watchlist.families.length} families`);

  // 2) Store: open + reconcile plans from the watchlist (idempotent, no migration).
  const store = openStore();
  const seeded = store.seedFromWatchlist(watchlist);
  console.log(
    `[index] db ${DB_FILE} — ${seeded.plansInserted} inserted, ${seeded.plansUpdated} updated, ${seeded.plansRemoved} removed (+${seeded.familiesRemoved} retired families)`,
  );

  // 3) Watcher (default page source = CDP attach to the dedicated Chrome).
  const watcher = createWatcher({ store, watchlist });

  // 4) Notifier: real Telegram (fetch + telegram_log) or the no-op when creds absent.
  const notifier = wireNotifier({ secrets, store });

  // 5) Localhost panel server (HTTP + SSE) — its broadcast hook is the fan-out the
  //    scheduler pushes every watcher event into, so the panel sees edges live.
  const server = createPanelServer({ store, watchlist, watchlistPath: WATCHLIST_FILE });
  const port = await server.start();

  // 5b) Public-board publisher (OFF unless both push keys are configured). The
  //     watchlist getter is the panel server's LIVE ref, never a boot copy — a
  //     family removed via the panel disappears from the very next push.
  const publisher = wirePublisher({
    config: loadPushConfig(),
    getWatchlist: () => server.watchlist,
    store,
  });

  // 6) Wire + run. The scheduler routes watcher events → notifier AND the composed
  //    broadcast: panel SSE first (local latency unaffected), then the publisher.
  const scheduler = createScheduler({
    watcher,
    notifier,
    store,
    broadcast: (ev, payload) => {
      server.broadcast(ev, payload);
      publisher.onEvent(ev, payload);
    },
  });
  scheduler.start();
  console.log(`[index] running — panel at http://127.0.0.1:${port} — Ctrl-C to stop`);

  // 7) Graceful shutdown.
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[index] ${signal} — shutting down`);
    try {
      await scheduler.stop();
      await publisher.stop(); // clears the debounce timer + aborts any in-flight push
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

// Run only when executed directly (`node src/index.js`) — tests import the
// exported wiring seams above without booting the stack.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
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

  main().catch((err) => {
    console.error(`[index] fatal: ${err.message}`);
    process.exit(1);
  });
}
