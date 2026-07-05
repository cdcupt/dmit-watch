// Unit tests for board-server/notifier.js (round-2 TECH §Q1.2 WIN-U*, §Q1.3
// DSP-U*, §Q1.4 SND-U*): the 75 s digest window (run at ~15 ms — the publisher
// debounceMs precedent), the crash-safe queue dispatcher, and the pure card
// builders/transport. captureFetch follows the telegram.test.js:40 idiom; the
// clock, sleep, and windowMs are injected — no real timers beyond the tiny
// window, no network, no ports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import {
  buildDigestCard,
  buildReceiptCard,
  createNotifier,
  escHtml,
  mapSendFailure,
  postOnce,
} from '../board-server/notifier.js';
import { STOCK } from '../board-server/edge-detect.js';
import { openSubStore } from '../board-server/sub-store.js';

const TOKEN_KEY = '33'.repeat(32);
const KEY_B = '44'.repeat(32);
const SUB_TOKEN = '8000000001:TESTSENTINELTOKENxxxxxxxxxxxxxxxx'; // §Q0 sentinel convention
const CHAT_ID = '4400000042';
const T0 = Date.parse('2026-07-05T14:32:00.000Z');
const MIN = 60_000;

// The MarkdownV2-killer fixture set (dotted names, $ prices) through HTML mode.
const PLAN_FIXTURES = [
  { id: 'x', name: 'HKG.AS3.Pro.TINY', price: '$39.90', period: 'mo', city: 'Hong Kong', deepLink: 'https://www.dmit.io/cart.php?region=hong-kong&network=premium' },
  { id: 'y', name: 'HKG.AS3.Pro.MICRO', price: '$179.90', period: 'mo', city: 'Hong Kong', deepLink: 'https://www.dmit.io/cart.php?region=hong-kong&network=premium' },
  { id: 'z', name: 'TYO.AS3.Pro.MICRO', price: '$189.90', period: 'mo', city: 'Tokyo', deepLink: 'https://www.dmit.io/cart.php?region=tokyo&network=premium' },
];
const fixtureIndex = (ids = ['x', 'y', 'z']) =>
  new Map(PLAN_FIXTURES.filter((p) => ids.includes(p.id)).map((p) => [p.id, p]));

const tgResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/**
 * One notifier over a fresh store with a scriptable fake Telegram
 * (telegram.test.js:40 captureFetch idiom). script(call) may return
 * {status, body}, 'hang', or a function that throws/rejects.
 */
function harness({ script, windowMs = 15, index = fixtureIndex(), dbFile = ':memory:', tokenKey = TOKEN_KEY } = {}) {
  const store = openSubStore(dbFile, { tokenKey });
  const clock = { t: T0 };
  const calls = [];
  const sleeps = [];
  const logs = [];
  const logger = { log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) };
  const fetchImpl = (url, init = {}) => {
    const call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const spec = script ? script(call) : null;
    if (spec === 'hang') return new Promise(() => {});
    if (typeof spec === 'function') return spec(call);
    const { status = 200, body = { ok: true, result: {} } } = spec ?? {};
    return Promise.resolve(tgResponse(status, body));
  };
  const notifier = createNotifier({
    store,
    getPlanIndex: () => index,
    fetch: fetchImpl,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    windowMs,
    sendTimeoutMs: 40,
    logger,
  });
  return { store, notifier, clock, calls, sleeps, logs };
}

const seedArmed = (store, ids, t = T0) => ids.forEach((id) => store.observePlan(id, STOCK.OUT, t));
const insertQueueRow = (store, { subscriberId, planIds, createdAt, sentTs = null, lastError = null }) =>
  store.db
    .prepare('INSERT INTO digest_queue (subscriber_id, plan_ids, created_at, attempts, sent_ts, last_error) VALUES (?, ?, ?, 0, ?, ?)')
    .run(subscriberId, JSON.stringify(planIds), createdAt, sentTs, lastError);

// ---- WIN: the digest window ----------------------------------------------------

test('WIN-U1: a burst of fired edges coalesces into ONE window; windowOpenedAt = the FIRST edge time', async () => {
  const { store, notifier, calls } = harness({});
  store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x', 'y', 'z'], now: T0 });
  seedArmed(store, ['x', 'y', 'z']);
  notifier.noteFire('x', T0 + 100); // three simulated family pushes inside one window
  notifier.noteFire('y', T0 + 150);
  notifier.noteFire('z', T0 + 200);
  await notifier.whenIdle();
  const rows = store.allQueueRows();
  assert.equal(rows.length, 1, 'exactly one window close → one queue generation');
  assert.deepEqual(JSON.parse(rows[0].plan_ids), ['x', 'y', 'z'], 'the union of all fired planIds');
  assert.equal(rows[0].created_at, T0 + 100, 'created_at = the FIRST edge time');
  assert.equal(calls.filter((c) => c.url.endsWith('/sendMessage')).length, 1, 'one digest card');
});

test('WIN-U2: mid-window dedup by planId — the same plan firing twice yields one line', async () => {
  const { store, notifier } = harness({});
  store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x'], now: T0 });
  seedArmed(store, ['x']);
  notifier.noteFire('x', T0 + 100);
  notifier.noteFire('x', T0 + 110); // the §B2 timing hole: disarm not yet persisted → re-fire
  assert.equal(notifier.pendingCount(), 1, 'Set contains the planId once');
  await notifier.whenIdle();
  const rows = store.allQueueRows();
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].plan_ids), ['x']);
});

test('WIN-U3: mid-window OUT retraction — never announced, stays armed; the card lists only plans still believed IN', async () => {
  const { store, notifier, calls } = harness({});
  store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x', 'y'], now: T0 });
  seedArmed(store, ['x', 'y']);
  notifier.noteFire('x', T0 + 100);
  notifier.noteFire('y', T0 + 105);
  notifier.retract('x'); // a later push inside the window observed x OUT again
  await notifier.whenIdle();
  const rows = store.allQueueRows();
  assert.deepEqual(JSON.parse(rows[0].plan_ids), ['y']);
  assert.equal(store.getEdge('x').armed, 1, 'retracted plan stays armed');
  assert.equal(store.getEdge('y').armed, 0);
  const card = calls[0].body.text;
  assert.ok(card.includes('HKG.AS3.Pro.MICRO'), 'y announced');
  assert.ok(!card.includes('HKG.AS3.Pro.TINY'), 'x never announced');
});

test('WIN-U4: window close disarms fired plans and enqueues per enabled intersecting subscriber only', () => {
  const { store } = harness({});
  const p = store.createSubscriber({ token: SUB_TOKEN, chatId: '4400000001', planIds: ['x', 'y'], now: T0 });
  const q = store.createSubscriber({ token: '8000000002:TESTSENTINELTOKENyyyyyyyyyyyyyyyy', chatId: '4400000002', planIds: ['z'], now: T0 });
  const r = store.createSubscriber({ token: '8000000003:TESTSENTINELTOKENzzzzzzzzzzzzzzzz', chatId: '4400000003', planIds: ['x'], now: T0 });
  store.disableSubscriber(r.id); // skipped at ENQUEUE time (WHERE disabled=0), not send time
  seedArmed(store, ['x']);
  const { enqueued } = store.closeDigestWindow({ firedPlanIds: ['x'], edgeTime: T0 + 500, now: T0 + 600 });
  assert.equal(enqueued, 1, 'one row: the overlapping enabled subscriber only');
  const rows = store.allQueueRows();
  assert.equal(rows[0].subscriber_id, p.id);
  assert.deepEqual(JSON.parse(rows[0].plan_ids), ['x'], 'fired ∩ plan_ids');
  assert.ok(!rows.some((row) => row.subscriber_id === q.id), 'disjoint subscriber → no row');
  assert.deepEqual({ ...store.getEdge('x') }, { plan_id: 'x', last_known: 'IN', armed: 0, last_change: T0 + 500 });
});

test('WIN-U5: transaction atomicity — a failure mid-close rolls back BOTH the disarm and the enqueue', () => {
  const { store } = harness({});
  const sub = store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x'], now: T0 });
  store.db.prepare('UPDATE subscribers SET plan_ids = ? WHERE id = ?').run('not-json', sub.id); // poisoned row
  seedArmed(store, ['x']);
  assert.throws(() => store.closeDigestWindow({ firedPlanIds: ['x'], edgeTime: T0 + 500, now: T0 + 500 }));
  assert.equal(store.getEdge('x').armed, 1, 'ROLLBACK left the plan armed (no swallowed alert)');
  assert.deepEqual(store.allQueueRows(), [], 'and nothing enqueued (no double card)');
});

test('WIN-U6: after a close, the next edge opens a NEW independent window', async () => {
  const { store, notifier, calls } = harness({});
  store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x', 'y'], now: T0 });
  seedArmed(store, ['x', 'y']);
  notifier.noteFire('x', T0 + 100);
  await notifier.whenIdle(); // window 1 closed
  notifier.noteFire('y', T0 + 90_000);
  await notifier.whenIdle(); // window 2 closed
  const rows = store.allQueueRows();
  assert.equal(rows.length, 2, 'two independent queue generations');
  assert.deepEqual(rows.map((r) => r.created_at), [T0 + 100, T0 + 90_000], 'each with its own windowOpenedAt');
  assert.equal(calls.length, 2);
});

test('WIN-U7: window close prunes only queue rows older than 24 h; younger unsent rows untouched', () => {
  const { store, clock } = harness({});
  const sub = store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x', 'y'], now: T0 });
  insertQueueRow(store, { subscriberId: sub.id, planIds: ['x'], createdAt: T0 - 25 * 60 * MIN, sentTs: T0 - 24 * 60 * MIN });
  insertQueueRow(store, { subscriberId: sub.id, planIds: ['x'], createdAt: T0 - 25 * 60 * MIN, lastError: 'expired' });
  insertQueueRow(store, { subscriberId: sub.id, planIds: ['y'], createdAt: T0 - 60 * MIN }); // 1 h old, unsent
  seedArmed(store, ['x']);
  clock.t = T0;
  store.closeDigestWindow({ firedPlanIds: ['x'], edgeTime: T0, now: T0 });
  const rows = store.allQueueRows();
  assert.equal(rows.length, 2, 'the two >24h rows pruned; the young unsent row + the new row remain');
  assert.ok(rows.some((r) => r.created_at === T0 - 60 * MIN), 'younger unsent row untouched');
  assert.ok(rows.some((r) => r.created_at === T0), 'the fresh enqueue');
});

test('WIN-U8: the window timer is unref’d — an open window never holds the process open', () => {
  const { store, notifier } = harness({ windowMs: 60_000 });
  store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x'], now: T0 });
  seedArmed(store, ['x']);
  notifier.noteFire('x', T0);
  assert.equal(notifier.pendingCount(), 1);
  // Deliberately neither closed nor stopped: node --test exiting cleanly IS the assertion.
});

// ---- DSP: the queue dispatcher ---------------------------------------------------

test('DSP-U1: happy send + bookkeeping — decrypted token in the URL, pinned payload, sent_ts, fail_count reset', async () => {
  const { store, notifier, clock, calls } = harness({});
  const sub = store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x'], now: T0 });
  seedArmed(store, ['x']);
  store.closeDigestWindow({ firedPlanIds: ['x'], edgeTime: T0 + 500, now: T0 + 500 });
  clock.t = T0 + 90_000; // dispatch happens later than the edge
  await notifier.dispatch();
  assert.equal(calls.length, 1, 'exactly one fetch');
  assert.equal(calls[0].url, `https://api.telegram.org/bot${SUB_TOKEN}/sendMessage`);
  const payload = calls[0].body;
  assert.equal(payload.chat_id, CHAT_ID);
  assert.equal(payload.parse_mode, 'HTML');
  assert.deepEqual(payload.link_preview_options, { is_disabled: true });
  assert.ok(payload.text.includes('HKG.AS3.Pro.TINY'));
  const row = store.allQueueRows()[0];
  assert.equal(row.sent_ts, T0 + 90_000);
  assert.equal(row.attempts, 1);
  const after = store.getSubscriber(sub.id);
  assert.equal(after.fail_count, 0);
  assert.equal(after.last_ok_ts, T0 + 90_000);
});

test('DSP-U2: per-subscriber isolation at concurrency 3 — one hung send never blocks the others', async () => {
  const { store, notifier, calls } = harness({
    script: (call) => (call.body?.chat_id === '4400000001' ? 'hang' : null), // A hangs; B, C deliver
  });
  const subs = [
    ['8000000001:TESTSENTINELTOKENaaaaaaaaaaaaaaaa', '4400000001'],
    ['8000000002:TESTSENTINELTOKENbbbbbbbbbbbbbbbb', '4400000002'],
    ['8000000003:TESTSENTINELTOKENcccccccccccccccc', '4400000003'],
  ].map(([token, chatId]) => store.createSubscriber({ token, chatId, planIds: ['x'], now: T0 }));
  seedArmed(store, ['x']);
  store.closeDigestWindow({ firedPlanIds: ['x'], edgeTime: T0, now: T0 });
  await notifier.whenIdle(); // resolves once A's timeout reaps the hang
  await notifier.dispatch();
  await notifier.whenIdle();
  const rows = store.allQueueRows();
  const byId = new Map(rows.map((r) => [r.subscriber_id, r]));
  assert.ok(byId.get(subs[1].id).sent_ts, 'B delivered despite A hanging');
  assert.ok(byId.get(subs[2].id).sent_ts, 'C delivered despite A hanging');
  const a = byId.get(subs[0].id);
  assert.equal(a.sent_ts, null, 'A never delivered');
  assert.equal(a.last_error, 'timeout', 'the hang was reaped by the per-attempt abort');
  assert.ok(calls.filter((c) => c.body?.chat_id === '4400000002').length >= 1);
});

test('DSP-U3: Telegram 401/403 → disabled after ONE attempt, redacted last_error, no retries (R6)', async () => {
  for (const [status, expected] of [[401, 'unauthorized'], [403, 'forbidden']]) {
    const { store, notifier, calls } = harness({
      script: () => ({ status, body: { ok: false, error_code: status, description: 'Forbidden: bot was blocked by the user' } }),
    });
    const sub = store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x'], now: T0 });
    seedArmed(store, ['x']);
    store.closeDigestWindow({ firedPlanIds: ['x'], edgeTime: T0, now: T0 });
    await notifier.dispatch();
    assert.equal(calls.length, 1, `${status}: exactly one attempt`);
    assert.equal(store.getSubscriber(sub.id).disabled, 1, `${status}: disabled immediately`);
    const row = store.allQueueRows()[0];
    assert.equal(row.last_error, expected, `${status}: enum, never the description`);
    assert.ok(!row.last_error.includes('blocked'), 'description text discarded');
  }
});

test('DSP-U4: exhausted attempts — exactly 3 tries, 500ms·2ⁿ backoff bases, fail_count+1, row stays unsent', async () => {
  const { store, notifier, calls, sleeps } = harness({ script: () => ({ status: 500, body: { ok: false, description: 'Internal' } }) });
  const sub = store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x'], now: T0 });
  seedArmed(store, ['x']);
  store.closeDigestWindow({ firedPlanIds: ['x'], edgeTime: T0, now: T0 });
  await notifier.dispatch();
  assert.equal(calls.length, 3, 'exactly 3 attempts');
  assert.equal(sleeps.length, 2, 'backoff between attempts only');
  assert.ok(sleeps[0] >= 500 && sleeps[0] < 1000, `first backoff ≈ 500·2⁰ + jitter (got ${sleeps[0]})`);
  assert.ok(sleeps[1] >= 1000 && sleeps[1] < 1500, `second backoff ≈ 500·2¹ + jitter (got ${sleeps[1]})`);
  const row = store.allQueueRows()[0];
  assert.equal(row.attempts, 3);
  assert.equal(row.sent_ts, null, 'remains unsent for the boot re-drain');
  assert.equal(row.last_error, 'http 500');
  assert.equal(store.getSubscriber(sub.id).fail_count, 1);
  assert.equal(store.getSubscriber(sub.id).disabled, 0);
});

test('DSP-U5: 5 consecutive exhausted dispatches disable; any success resets the counter', async () => {
  let failing = true;
  const { store, notifier } = harness({ script: () => (failing ? { status: 500, body: { ok: false } } : null) });
  const sub = store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x'], now: T0 });
  seedArmed(store, ['x']);
  store.closeDigestWindow({ firedPlanIds: ['x'], edgeTime: T0, now: T0 });
  for (let i = 1; i <= 4; i++) {
    await notifier.dispatch();
    assert.equal(store.getSubscriber(sub.id).fail_count, i);
  }
  assert.equal(store.getSubscriber(sub.id).disabled, 0, 'not yet disabled at 4');
  failing = false;
  await notifier.dispatch(); // success
  assert.equal(store.getSubscriber(sub.id).fail_count, 0, 'success resets the counter');
  // A new digest generation, then 5 consecutive exhausted dispatches.
  store.observePlan('x', STOCK.OUT, T0 + 1000); // re-arm
  store.closeDigestWindow({ firedPlanIds: ['x'], edgeTime: T0 + 2000, now: T0 + 2000 });
  failing = true;
  for (let i = 1; i <= 5; i++) {
    await notifier.dispatch();
    assert.equal(store.getSubscriber(sub.id).disabled, i >= 5 ? 1 : 0, `after exhausted dispatch #${i}`);
  }
});

test('DSP-U6: TTL 30 min — a stale unsent row is marked expired with zero fetch calls', async () => {
  const { store, notifier, clock, calls } = harness({});
  const sub = store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x'], now: T0 });
  insertQueueRow(store, { subscriberId: sub.id, planIds: ['x'], createdAt: T0 - 31 * MIN });
  clock.t = T0;
  await notifier.dispatch();
  assert.equal(calls.length, 0, 'never sent');
  assert.equal(store.allQueueRows()[0].last_error, 'expired');
  assert.equal(store.allQueueRows()[0].sent_ts, null);
});

test('DSP-U7: boot re-drain — a fresh notifier sends the 25-min row exactly once and expires the 31-min row', async () => {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'dmit-notif-')), 'board.db');
  const seed = harness({ dbFile });
  const sub = seed.store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x', 'y'], now: T0 });
  insertQueueRow(seed.store, { subscriberId: sub.id, planIds: ['x'], createdAt: T0 - 25 * MIN });
  insertQueueRow(seed.store, { subscriberId: sub.id, planIds: ['y'], createdAt: T0 - 31 * MIN });
  seed.store.close();

  const fresh = harness({ dbFile }); // "construct a fresh notifier over it"
  await fresh.notifier.dispatch(); // what the server boot does after loadSnapshot()
  assert.equal(fresh.calls.length, 1, 'the 25-min row dispatches exactly once (at-least-once delivery)');
  const rows = fresh.store.allQueueRows();
  assert.ok(rows.find((r) => r.created_at === T0 - 25 * MIN).sent_ts, '25-min row sent');
  assert.equal(rows.find((r) => r.created_at === T0 - 31 * MIN).last_error, 'expired', '31-min row expired');
  fresh.store.close();
});

test('DSP-U8: the card is built from the LATEST snapshot — vanished lines drop; all vanished → sent, no card', async () => {
  const partial = harness({ index: fixtureIndex(['x']) }); // y gone from the snapshot
  const subA = partial.store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x', 'y'], now: T0 });
  insertQueueRow(partial.store, { subscriberId: subA.id, planIds: ['x', 'y'], createdAt: T0 });
  await partial.notifier.dispatch();
  assert.equal(partial.calls.length, 1);
  assert.ok(partial.calls[0].body.text.includes('HKG.AS3.Pro.TINY'), 'x kept');
  assert.ok(!partial.calls[0].body.text.includes('HKG.AS3.Pro.MICRO'), 'y dropped');

  const empty = harness({ index: fixtureIndex([]) }); // both gone
  const subB = empty.store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x', 'y'], now: T0 });
  insertQueueRow(empty.store, { subscriberId: subB.id, planIds: ['x', 'y'], createdAt: T0 });
  await empty.notifier.dispatch();
  assert.equal(empty.calls.length, 0, 'no fetch at all');
  assert.ok(empty.store.allQueueRows()[0].sent_ts, 'marked sent — nothing left to say');
});

test('DSP-U9: never throws, never leaks rejections — throwing and rejecting fetches are absorbed', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    let mode = 'throw';
    const { store, notifier, calls } = harness({
      script: () => {
        if (mode === 'throw') throw new Error(`sync boom https://api.telegram.org/bot${SUB_TOKEN}/sendMessage`);
        if (mode === 'reject') return () => Promise.reject(new Error('async boom'));
        return null;
      },
    });
    const sub = store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x'], now: T0 });
    insertQueueRow(store, { subscriberId: sub.id, planIds: ['x'], createdAt: T0 });
    await notifier.dispatch(); // sync-throwing fetch
    mode = 'reject';
    await notifier.dispatch(); // rejecting fetch
    mode = 'ok';
    await notifier.dispatch(); // a later dispatch proceeds normally
    assert.ok(store.allQueueRows()[0].sent_ts, 'eventually delivered');
    assert.ok(calls.length >= 7, 'each failing dispatch burned its 3 attempts');
    await new Promise((r) => setTimeout(r, 10)); // let any stray rejection surface
    assert.deepEqual(unhandled, [], 'zero unhandled rejections');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('DSP-U10: GCM decrypt failure (key rotation) disables the row with a redacted warn; others still dispatch', async () => {
  const dbFile = join(mkdtempSync(join(tmpdir(), 'dmit-notif-rot-')), 'board.db');
  const a = openSubStore(dbFile, { tokenKey: TOKEN_KEY });
  const rotted = a.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x'], now: T0 });
  a.close();

  const h = harness({ dbFile, tokenKey: KEY_B }); // the store was written under TOKEN_KEY
  const healthy = h.store.createSubscriber({ token: '8000000002:TESTSENTINELTOKENbbbbbbbbbbbbbbbb', chatId: '4400000002', planIds: ['y'], now: T0 });
  insertQueueRow(h.store, { subscriberId: rotted.id, planIds: ['x'], createdAt: T0 });
  insertQueueRow(h.store, { subscriberId: healthy.id, planIds: ['y'], createdAt: T0 });
  await h.notifier.dispatch();
  assert.equal(h.store.getSubscriber(rotted.id).disabled, 1, 'rotated row disabled');
  const rottedRow = h.store.allQueueRows().find((r) => r.subscriber_id === rotted.id);
  assert.equal(rottedRow.last_error, 'decrypt-failed');
  const warns = h.logs.filter((l) => /decrypt failed/.test(l));
  assert.equal(warns.length, 1, 'one warn');
  assert.ok(warns[0].includes(`row ${rottedRow.id}`), 'names the row id only');
  assert.ok(!warns[0].includes(SUB_TOKEN) && !warns[0].includes('TESTSENTINEL'), 'never the token/ciphertext');
  assert.ok(h.store.allQueueRows().find((r) => r.subscriber_id === healthy.id).sent_ts, 'other rows still dispatch');
  h.store.close();
});

// ---- SND: sender + card builders --------------------------------------------------

test('SND-U1: escHtml matrix — & first, pre-escaped input re-escapes, everything else untouched', () => {
  assert.equal(escHtml('&'), '&amp;');
  assert.equal(escHtml('<'), '&lt;');
  assert.equal(escHtml('>'), '&gt;');
  assert.equal(escHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  assert.equal(escHtml('&lt;'), '&amp;lt;', 'no double-decode hole: & escaped FIRST');
  assert.equal(escHtml('HKG.AS3.Pro.TINY $39.90/mo · "quotes" \'fine\''), 'HKG.AS3.Pro.TINY $39.90/mo · "quotes" \'fine\'');
});

test('SND-U2: digest card matches DESIGN §6 byte-for-byte with the real fixture names', () => {
  const edgeTime = Date.parse('2026-07-05T14:32:00.000Z');
  const card = buildDigestCard({ plans: PLAN_FIXTURES, edgeTime });
  const lines = card.split('\n');
  assert.equal(lines[0], '<b>🟢 Restock — 3 of your plans are IN STOCK</b>');
  assert.equal(lines[1], '');
  assert.equal(
    lines[2],
    '• <b>HKG.AS3.Pro.TINY</b> — $39.90/mo — Hong Kong · <a href="https://www.dmit.io/cart.php?region=hong-kong&amp;network=premium">Buy now</a>',
  );
  assert.ok(lines[3].startsWith('• <b>HKG.AS3.Pro.MICRO</b> — $179.90/mo — Hong Kong'), 'snapshot encounter order');
  assert.ok(lines[4].startsWith('• <b>TYO.AS3.Pro.MICRO</b> — $189.90/mo — Tokyo'));
  assert.equal(lines[5], '');
  assert.equal(lines[6], 'as of 14:32 UTC · data can lag ~5 min', '"as of" = the passed edge time, not now');
  assert.equal(lines[7], 'manage: vps-stock.daichenlab.com/?manage=1');
  const single = buildDigestCard({ plans: PLAN_FIXTURES.slice(0, 1), edgeTime });
  assert.ok(single.startsWith('<b>🟢 Restock — 1 of your plans is IN STOCK</b>'), 'singular at n=1');
});

test('SND-U3: receipt card + 🔄 variant — name — city bullets, no prices, no buy links, shared footer', () => {
  const card = buildReceiptCard({ plans: PLAN_FIXTURES });
  const lines = card.split('\n');
  assert.equal(lines[0], '<b>✅ Subscribed — VPS Stock Watch</b>');
  assert.equal(lines[2], "You'll get ONE digest card here when any of your 3 plans restock:");
  assert.equal(lines[4], '• HKG.AS3.Pro.TINY — Hong Kong');
  assert.equal(lines[8], 'checks run ~every 5 min · a plan re-alerts only after it goes out of stock again');
  assert.equal(lines[9], 'manage: vps-stock.daichenlab.com/?manage=1');
  assert.ok(!card.includes('$'), 'a receipt, not a pitch: no prices');
  assert.ok(!card.includes('<a '), 'no buy links');
  const updated = buildReceiptCard({ plans: PLAN_FIXTURES, updated: true });
  assert.ok(updated.startsWith('<b>🔄 Subscription updated</b>'), 'the update variant header');
  assert.ok(updated.includes('manage: vps-stock.daichenlab.com/?manage=1'), 'same footer module');
});

test('SND-U4: truncation at 25 lines with "+{k} more — see the board"; total stays under 4096', () => {
  // Telegram's 4096 cap counts characters AFTER entities parsing (the visible
  // text), so measure what Telegram measures: tags stripped, entities decoded.
  const parsedLength = (card) =>
    card.replace(/<[^>]+>/g, '').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').length;
  const longName = 'LAX.AN4.Pro.MAXIMAL-LENGTH-PLAN-NAME-FOR-TRUNCATION-TESTS';
  const mk = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      name: `${longName}.${String(i).padStart(3, '0')}`,
      price: '$759.90',
      period: 'mo',
      city: 'Los Angeles',
      deepLink: 'https://www.dmit.io/cart.php?region=los-angeles&network=premium&generation=an4',
    }));
  for (const [count, k] of [[26, 1], [40, 15]]) {
    const digest = buildDigestCard({ plans: mk(count), edgeTime: T0 });
    assert.equal(digest.split('\n').filter((l) => l.startsWith('• ')).length, 25, `${count}: cut at 25 lines`);
    assert.ok(digest.includes(`+${k} more — see the board`), `${count}: +${k} more, plain text`);
    assert.ok(parsedLength(digest) < 4096, `${count}: digest ${parsedLength(digest)} parsed chars < 4096`);
    const receipt = buildReceiptCard({ plans: mk(count) });
    assert.ok(receipt.includes(`+${k} more — see the board`), 'receipt shares the truncation');
    assert.ok(parsedLength(receipt) < 4096, `${count}: receipt < 4096`);
  }
});

test('SND-U5: deep-link scheme gate — javascript:/data: links render no anchor (the render.js safeHref rule)', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x', null]) {
    const card = buildDigestCard({ plans: [{ ...PLAN_FIXTURES[0], deepLink: bad }], edgeTime: T0 });
    assert.ok(!card.includes('<a '), `no anchor for ${String(bad)}`);
    assert.ok(card.includes('• <b>HKG.AS3.Pro.TINY</b> — $39.90/mo — Hong Kong'), 'the line itself survives');
  }
});

test('SND-U6: postOnce contract — AbortSignal present, resolves {ok,status,description} for ok/4xx/reject, never throws', async () => {
  const calls = [];
  const okFetch = async (url, init) => {
    calls.push({ url, init });
    return tgResponse(200, { ok: true, result: { message_id: 7 } });
  };
  const ok = await postOnce({ fetch: okFetch, token: SUB_TOKEN, chatId: CHAT_ID, text: 'hi', timeoutMs: 50 });
  assert.deepEqual(ok, { ok: true, status: 200, description: null });
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'the 10 s abort path is wired');
  assert.equal(calls[0].url, `https://api.telegram.org/bot${SUB_TOKEN}/sendMessage`);

  const tooMany = await postOnce({
    fetch: async () => tgResponse(429, { ok: false, description: 'Too Many Requests' }),
    token: SUB_TOKEN,
    chatId: CHAT_ID,
    text: 'hi',
    timeoutMs: 50,
  });
  assert.deepEqual(tooMany, { ok: false, status: 429, description: 'Too Many Requests' });

  const rejected = await postOnce({
    fetch: () => Promise.reject(new Error(`ECONNREFUSED https://api.telegram.org/bot${SUB_TOKEN}/sendMessage`)),
    token: SUB_TOKEN,
    chatId: CHAT_ID,
    text: 'hi',
    timeoutMs: 50,
  });
  assert.deepEqual(rejected, { ok: false, status: 0, description: 'network' }, 'URL-bearing error message redacted');

  assert.equal(mapSendFailure({ status: 401, description: null }), 'token_rejected');
  assert.equal(mapSendFailure({ status: 404, description: null }), 'token_rejected');
  assert.equal(mapSendFailure({ status: 403, description: 'Forbidden' }), 'chat_not_found');
  assert.equal(mapSendFailure({ status: 400, description: 'Bad Request: chat not found' }), 'chat_not_found');
  assert.equal(mapSendFailure({ status: 500, description: 'boom' }), null);
});

test('SND-U6b: synchronous confirmation/receipt sends are single-attempt — no retry loop outside the dispatcher', async () => {
  const { notifier, calls } = harness({ script: () => ({ status: 500, body: { ok: false, description: 'Internal' } }) });
  const result = await notifier.sendCard({ token: SUB_TOKEN, chatId: CHAT_ID, text: 'hello' });
  assert.deepEqual(result, { ok: false, reason: null });
  assert.equal(calls.length, 1, 'exactly one attempt — the user is watching and retries by hand');
});

test('SND-U7: redaction everywhere — no token and no tokened URL in any log line, last_error, or resolved value', async () => {
  const { store, notifier, logs } = harness({
    script: () => () => Promise.reject(new Error(`connect failed: https://api.telegram.org/bot${SUB_TOKEN}/sendMessage`)),
  });
  const sub = store.createSubscriber({ token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['x'], now: T0 });
  insertQueueRow(store, { subscriberId: sub.id, planIds: ['x'], createdAt: T0 });
  await notifier.dispatch();
  const sweep = [...logs, ...store.allQueueRows().map((r) => String(r.last_error))];
  for (const line of sweep) {
    assert.ok(!line.includes(SUB_TOKEN), `token leaked: ${line}`);
    assert.ok(!line.includes('TESTSENTINEL'), `token fragment leaked: ${line}`);
    assert.ok(!/api\.telegram\.org\/bot/.test(line), `tokened URL leaked: ${line}`);
  }
  assert.equal(store.allQueueRows()[0].last_error, 'network');
  assert.equal(notifier.endpointRedacted, 'https://api.telegram.org/bot<redacted>/sendMessage');
});
