// Telegram notifier tests — fully mocked fetch + injected secrets. NEVER touches
// the real Bot API. Covers message format, retry/backoff, exhaustion, the
// telegram_log row, and the never-throws guarantee.  npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEdgeMessage,
  buildBlindMessage,
  createTelegramNotifier,
} from '../src/telegram.js';
import { openStore } from '../src/store.js';
import { loadWatchlist } from '../src/config.js';

const SECRETS = { botToken: 'TESTBOTTOKEN', chatId: '424242' };
const NOSLEEP = async () => {};
const silent = { log() {}, warn() {}, error() {} };

const PLAN = {
  id: 'lax-an4-medium',
  name: 'LAX.AN4.Pro.MEDIUM',
  price: '$239.90',
};
const FAMILY = {
  key: 'lax/an4',
  label: 'LAX·AN4',
  city: 'Los Angeles',
  genLabel: 'AN4',
  cpu: 'EPYC 9004',
};
const DEEP_LINK =
  'https://www.dmit.io/cart.php?region=los-angeles&network=premium&generation=an4&language=english';

function seededStore() {
  const store = openStore(':memory:');
  store.seedFromWatchlist(loadWatchlist());
  return store;
}

function captureFetch({ failTimes = 0, status = 429 } = {}) {
  const calls = [];
  let n = 0;
  const fetch = async (url, init) => {
    n += 1;
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (n <= failTimes) {
      return { ok: false, status, json: async () => ({ ok: false, description: 'Too Many Requests' }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: n } }) };
  };
  return { fetch, calls };
}

test('buildEdgeMessage matches the TECH §06 four-line format', () => {
  const text = buildEdgeMessage({ plan: PLAN, family: FAMILY, deepLink: DEEP_LINK, now: 0 });
  const lines = text.split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], '🟢 IN STOCK — LAX.AN4.Pro.MEDIUM');
  assert.equal(lines[1], 'Los Angeles · EPYC 9004 (AN4) · $239.90/mo');
  assert.equal(lines[2], `Buy ▸ ${DEEP_LINK}`);
  assert.match(lines[3], /^detected \d{2}:\d{2}:\d{2}$/);
});

test('buildBlindMessage is the distinct blind alert and is re-clear aware', () => {
  const blocked = buildBlindMessage({ family: FAMILY, reasons: ['persistent-block'], now: 0 });
  assert.match(blocked, /^⚠️ Watcher may be blind — LAX·AN4/);
  assert.match(blocked, /Reasons: persistent-block/);
  assert.match(blocked, /re-clear Cloudflare/);

  const parseFail = buildBlindMessage({ family: FAMILY, reasons: ['structure-markers-missing'], now: 0 });
  assert.match(parseFail, /stopped parsing cleanly/);
});

test('notifyEdge sends once, returns ok, logs a sent telegram_log row', async () => {
  const store = seededStore();
  const { fetch, calls } = captureFetch();
  const tg = createTelegramNotifier({ secrets: SECRETS, store, fetch, sleep: NOSLEEP, logger: silent });

  const res = await tg.notifyEdge({ plan: PLAN, family: FAMILY, deepLink: DEEP_LINK });

  assert.equal(res.ok, true);
  assert.equal(res.attempts, 1);
  assert.equal(calls.length, 1);
  // payload shape
  assert.ok(calls[0].url.includes('/botTESTBOTTOKEN/sendMessage'));
  assert.equal(calls[0].body.chat_id, '424242');
  assert.equal(calls[0].body.disable_web_page_preview, false);
  assert.match(calls[0].body.text, /IN STOCK — LAX\.AN4\.Pro\.MEDIUM/);
  // logged
  const row = store.recentTelegram(1)[0];
  assert.equal(row.plan_id, 'lax-an4-medium');
  assert.equal(row.sent_ok, 1);
  assert.equal(row.attempts, 1);
  assert.equal(row.deep_link, DEEP_LINK);
  store.close();
});

test('send retries with backoff then succeeds (attempts counted)', async () => {
  const store = seededStore();
  const { fetch, calls } = captureFetch({ failTimes: 1 });
  const tg = createTelegramNotifier({ secrets: SECRETS, store, fetch, sleep: NOSLEEP, logger: silent });

  const res = await tg.notifyEdge({ plan: PLAN, family: FAMILY, deepLink: DEEP_LINK });

  assert.equal(res.ok, true);
  assert.equal(res.attempts, 2);
  assert.equal(calls.length, 2);
  assert.equal(store.recentTelegram(1)[0].attempts, 2);
  store.close();
});

test('send exhausts after maxAttempts and logs the failure (never throws)', async () => {
  const store = seededStore();
  const { fetch, calls } = captureFetch({ failTimes: 99 });
  const tg = createTelegramNotifier({
    secrets: SECRETS, store, fetch, sleep: NOSLEEP, logger: silent, maxAttempts: 3,
  });

  const res = await tg.notifyEdge({ plan: PLAN, family: FAMILY, deepLink: DEEP_LINK });

  assert.equal(res.ok, false);
  assert.equal(res.attempts, 3);
  assert.equal(calls.length, 3);
  const row = store.recentTelegram(1)[0];
  assert.equal(row.sent_ok, 0);
  assert.equal(row.attempts, 3);
  assert.match(row.last_error, /Too Many Requests/);
  store.close();
});

test('a fetch that throws is swallowed into a failed result, not propagated', async () => {
  const store = seededStore();
  const fetch = async () => {
    throw new Error('network down');
  };
  const tg = createTelegramNotifier({
    secrets: SECRETS, store, fetch, sleep: NOSLEEP, logger: silent, maxAttempts: 2,
  });

  const res = await tg.notifyBlind({ family: FAMILY, reasons: ['persistent-block'] });

  assert.equal(res.ok, false);
  assert.equal(res.attempts, 2);
  const row = store.recentTelegram(1)[0];
  assert.equal(row.plan_id, null); // blind alert is global
  assert.match(row.last_error, /network down/);
  store.close();
});

test('constructor rejects missing creds and exposes a redacted endpoint only', () => {
  assert.throws(
    () => createTelegramNotifier({ secrets: { botToken: '', chatId: '' }, fetch: async () => {} }),
    /botToken and chatId are required/,
  );
  const tg = createTelegramNotifier({ secrets: SECRETS, fetch: async () => {}, logger: silent });
  assert.ok(!tg.endpointRedacted.includes(SECRETS.botToken));
  assert.match(tg.endpointRedacted, /<redacted>/);
});
