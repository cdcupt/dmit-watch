#!/usr/bin/env node
// Smoke: dry-run the scheduler with a FAKE watcher emitting one OUT→IN edge and
// one blind event, through the REAL Telegram notifier with a MOCKED fetch — so a
// real payload is built and logged, but the live bot is never touched.
//
// Telegram is restock-only: the edge builds + logs a payload; the blind event is
// panel-only (broadcast to the panel) and must NOT produce any Telegram payload.
//
//   npm run smoke:alert

import { EventEmitter } from 'node:events';
import { createScheduler } from '../src/scheduler.js';
import { createTelegramNotifier } from '../src/telegram.js';
import { openStore } from '../src/store.js';
import { loadWatchlist } from '../src/config.js';

const line = () => console.log('─'.repeat(64));

function fakeWatcher() {
  const em = new EventEmitter();
  return {
    on: em.on.bind(em),
    off: em.off.bind(em),
    emit: em.emit.bind(em),
    start() {},
    async stop() {},
  };
}

async function main() {
  const watchlist = loadWatchlist();
  const store = openStore(':memory:');
  store.seedFromWatchlist(watchlist);

  const family = watchlist.families.find((f) => f.key === 'lax/an4');
  const plan = watchlist.plans.find((p) => p.id === 'lax-an4-medium');

  // Mock fetch: capture the outgoing payload, pretend Telegram said ok.
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };

  const notifier = createTelegramNotifier({
    secrets: { botToken: 'SMOKE-TOKEN', chatId: '99999' },
    store,
    fetch,
    sleep: async () => {},
  });

  const watcher = fakeWatcher();
  const events = [];
  const scheduler = createScheduler({
    watcher,
    notifier,
    store,
    broadcast: (e) => events.push(e),
  });

  console.log('dmit-watch alert smoke — fake watcher → real notifier → mocked fetch');
  line();
  scheduler.start();

  console.log('1. Emit one OUT→IN edge');
  watcher.emit('edge', { plan, family, deepLink: plan.deepLink });
  await scheduler.whenIdle();

  console.log('2. Emit one blind event (panel-only — must NOT hit telegram)');
  watcher.emit('blind', { family, reasons: ['persistent-block', 'persistent-unknown'] });
  await scheduler.whenIdle();

  await scheduler.stop();

  // ---- assertions --------------------------------------------------------
  line();
  // Telegram is restock-only: exactly ONE payload (the edge), none for blind.
  if (sent.length !== 1) throw new Error(`expected 1 telegram payload (edge only), got ${sent.length}`);

  const edgeMsg = sent[0].body;
  console.log('Edge payload built:');
  console.log(`  chat_id=${edgeMsg.chat_id}  preview=${edgeMsg.disable_web_page_preview}`);
  for (const l of edgeMsg.text.split('\n')) console.log(`    | ${l}`);
  if (!edgeMsg.text.includes('IN STOCK — LAX.AN4.Pro.MEDIUM')) throw new Error('edge text missing plan name');
  if (!edgeMsg.text.includes('$239.90/mo')) throw new Error('edge text missing price');
  if (!edgeMsg.text.includes(plan.deepLink)) throw new Error('edge text missing deep link');
  if (edgeMsg.disable_web_page_preview !== false) throw new Error('preview must be enabled (tappable link)');
  if (!sent[0].url.includes('/botSMOKE-TOKEN/sendMessage')) throw new Error('wrong endpoint');

  // blind must not have produced a telegram payload
  if (sent.some((s) => s.body.text.startsWith('⚠️ Watcher may be blind'))) {
    throw new Error('blind event leaked a telegram payload (must be panel-only)');
  }

  // only the edge is logged to telegram_log
  const rows = store.recentTelegram(10);
  console.log(`\ntelegram_log rows: ${rows.length} (sent_ok: ${rows.map((r) => r.sent_ok).join(',')})`);
  if (rows.length !== 1) throw new Error(`expected 1 telegram_log row (edge only), got ${rows.length}`);
  if (!rows.every((r) => r.sent_ok === 1)) throw new Error('the edge send should log sent_ok=1');

  // ...but the blind signal STILL reaches the panel via broadcast (SSE).
  console.log(`broadcast events seen: ${JSON.stringify(events)}`);
  if (!events.includes('edge') || !events.includes('blind')) throw new Error('panel broadcast missing events');

  store.close();
  line();
  console.log('OK: edge → telegram (built, logged); blind → panel broadcast only, no telegram (real bot untouched).');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
