// Local full-loop E2E for the round-2 subscription pipeline (TECH §Q4.1,
// E2E-S1…S7): the whole story on one real board-server — factory on
// 127.0.0.1:0, windowMs ~15 ms, injected clock, fakeTG recorder, real HTTP for
// both the watcher pushes and the subscriber's POSTs. Snapshot fixtures derive
// from test/fixtures/board-snapshot.json with per-plan status swaps.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createBoardServer } from '../board-server/server.js';
import { readFixture } from './helpers.js';

const PUSH_TOKEN = 'sentinel-push-token-e2e00000e2e00000e2e00000e2e00000';
const TOKEN_KEY = '66'.repeat(32); // built at runtime (SEC-6)
const SUB_TOKEN = '8000000001:TESTSENTINELTOKENxxxxxxxxxxxxxxxx';
const CHAT_ID = '4400000042';
const T0 = Date.parse('2026-07-04T14:00:00.000Z');
const FIXTURE_STATE = JSON.parse(readFixture('board-snapshot.json'));
const SILENT = { log() {}, warn() {}, error() {} };
const stok = (n) => `800000${String(n).padStart(4, '0')}:TESTSENTINELTOKEN${'x'.repeat(16)}`;

// Fixture anchors: X is OUT in the shipped fixture; Y_IN is the first IN plan.
const X = 'lax-as3-tiny';
const X_NAME = 'LAX.AS3.Pro.TINY';
const flat = (s) => s.datacenters.flatMap((dc) => dc.generations.flatMap((g) => g.plans));
const Y_IN = flat(FIXTURE_STATE).find((p) => p.status === 'in').id;

function makeFakeTG() {
  const calls = [];
  let script = null;
  const fetchImpl = (url, init = {}) => {
    const call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const spec = script ? script(call) : null;
    if (spec === 'hang') return new Promise(() => {});
    const { status = 200, body = { ok: true, result: {} } } = spec ?? {};
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  };
  return { calls, fetch: fetchImpl, setScript: (fn) => (script = fn) };
}

let xff = 0;
async function boot({ dir = mkdtempSync(join(tmpdir(), 'dmit-sub-e2e-')), windowMs = 15, clock = { t: T0 } } = {}) {
  const tg = makeFakeTG();
  const server = createBoardServer({
    port: 0,
    token: PUSH_TOKEN,
    snapshotFile: join(dir, 'snapshot.json'),
    staticDir: join(dir, 'no-static'), // static surface is not under test here
    subDbFile: join(dir, 'board.db'),
    tokenKey: TOKEN_KEY,
    telegramFetch: tg.fetch,
    windowMs,
    telegramTimeoutMs: 60,
    sleep: async () => {},
    now: () => clock.t,
    logger: SILENT,
  });
  const port = await server.start();
  const base = `http://127.0.0.1:${port}`;
  return {
    server,
    tg,
    base,
    dir,
    clock,
    push: (state) =>
      fetch(base + '/api/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${PUSH_TOKEN}` },
        body: JSON.stringify({ v: 1, pushedAt: clock.t, cadenceSec: 300, state }),
      }),
    post: (path, body, ip) =>
      fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip ?? `10.88.0.${(xff++ % 250) + 1}` },
        body: JSON.stringify(body),
      }),
    settle: async () => {
      await new Promise((r) => setTimeout(r, windowMs + 25));
      await server.whenSubsIdle();
    },
    db: () => new DatabaseSync(join(dir, 'board.db')),
    sends: () => tg.calls.filter((c) => c.url.endsWith('/sendMessage')),
    stop: () => server.stop(),
    close: async () => {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const withStatus = (statusById, base = FIXTURE_STATE) => {
  const clone = structuredClone(base);
  for (const dc of clone.datacenters)
    for (const g of dc.generations)
      for (const p of g.plans) if (statusById[p.id] !== undefined) p.status = statusById[p.id];
  return clone;
};

test('E2E-S1: the restock story, wire-level — seed, subscribe, R7 probe, exactly ONE byte-asserted digest, receipt, silent delete', async () => {
  const h = await boot();
  try {
    // ① push snapshot A: X out, Y in → seeded fire-free, 0 sends.
    assert.equal((await h.push(FIXTURE_STATE)).status, 200);
    await h.settle();
    assert.equal(h.sends().length, 0, 'cold start digest-blasts nobody');

    // ② subscribe {X, Y} → recorder call #1 = ✅ confirmation.
    const sub = await h.post('/api/subscribe', { token: SUB_TOKEN, chatId: CHAT_ID, planIds: [X, Y_IN] });
    assert.equal(sub.status, 200);
    assert.equal(h.sends().length, 1);
    assert.ok(h.sends()[0].body.text.startsWith('<b>✅ Subscribed — VPS Stock Watch</b>'));

    // ③ push unknown for X — the R7 probe: holds, 0 new sends, no state change.
    assert.equal((await h.push(withStatus({ [X]: 'checking' }))).status, 200);
    await h.settle();
    assert.equal(h.sends().length, 1, 'UNKNOWN never notifies (R7 at wire level)');

    // ④ push snapshot B: X flips in (armed OUT→IN) at a pinned clock.
    h.clock.t = Date.parse('2026-07-04T14:32:00.000Z');
    assert.equal((await h.push(withStatus({ [X]: 'in' }))).status, 200);

    // ⑤/⑥ the 15 ms window closes → EXACTLY ONE digest, byte-asserted.
    await h.settle();
    const sends = h.sends();
    assert.equal(sends.length, 2, 'exactly one digest for the restock');
    const digest = sends[1];
    assert.equal(digest.url, `https://api.telegram.org/bot${SUB_TOKEN}/sendMessage`, 'the subscriber’s OWN bot');
    assert.equal(digest.body.chat_id, CHAT_ID);
    assert.equal(digest.body.parse_mode, 'HTML');
    assert.deepEqual(digest.body.link_preview_options, { is_disabled: true });
    const lines = digest.body.text.split('\n');
    assert.equal(lines[0], '<b>🟢 Restock — 1 of your plans is IN STOCK</b>', 'singular header; Y never fired');
    assert.equal(
      lines[2],
      `• <b>${X_NAME}</b> — $10.90/mo — Los Angeles · <a href="https://www.dmit.io/cart.php?region=los-angeles&amp;network=premium&amp;generation=as3&amp;language=english">Buy now</a>`,
      'escaped dotted name, price/period, city, Buy-now anchor',
    );
    assert.equal(lines[4], 'as of 14:32 UTC · data can lag ~5 min', '"as of" = the edge time from the injected clock');
    assert.equal(lines[5], 'manage: vps-stock.daichenlab.com/?manage=1');

    // ⑦ push B again (X still in) → disarmed → 0 further sends.
    assert.equal((await h.push(withStatus({ [X]: 'in' }))).status, 200);
    await h.settle();
    assert.equal(h.sends().length, 2);

    // ⑧ manage update {Y} → recorder call #3 = 🔄 receipt.
    const upd = await h.post('/api/subscription/update', { token: SUB_TOKEN, chatId: CHAT_ID, planIds: [Y_IN] });
    assert.equal(upd.status, 200);
    assert.equal(h.sends().length, 3);
    assert.ok(h.sends()[2].body.text.startsWith('<b>🔄 Subscription updated</b>'), 'confirmation → digest → receipt, in that order');

    // ⑨ delete — silent; the row (and any pending digests) cascade away.
    assert.equal((await h.post('/api/subscription/delete', { token: SUB_TOKEN, chatId: CHAT_ID })).status, 200);
    assert.equal(h.sends().length, 3, 'unsubscribe sends nothing');
    assert.equal((await h.post('/api/subscription/lookup', { token: SUB_TOKEN, chatId: CHAT_ID })).status, 404);

    // ⑩ X out → in again with no subscribers left → the recorder stays at 3 calls, total.
    assert.equal((await h.push(withStatus({ [X]: 'out' }))).status, 200);
    assert.equal((await h.push(withStatus({ [X]: 'in' }))).status, 200);
    await h.settle();
    assert.equal(h.sends().length, 3, 'nobody left to tell');
  } finally {
    await h.close();
  }
});

test('E2E-S2: multi-subscriber fan-out — ONE card each, only their own plans; empty intersection gets nothing', async () => {
  const h = await boot();
  try {
    await h.push(FIXTURE_STATE);
    const roster = [
      ['P', stok(101), '4400000101', ['lax-as3-tiny']],
      ['Q', stok(102), '4400000102', ['lax-as3-pocket']],
      ['R', stok(103), '4400000103', ['lax-as3-tiny', 'lax-as3-pocket']],
      ['S', stok(104), '4400000104', ['lax-as3-starter']],
    ];
    for (const [, token, chatId, planIds] of roster) {
      assert.equal((await h.post('/api/subscribe', { token, chatId, planIds })).status, 200);
    }
    assert.equal(h.sends().length, 4, 'four confirmations');
    // X and Y restock inside one push → one window.
    await h.push(withStatus({ 'lax-as3-tiny': 'in', 'lax-as3-pocket': 'in' }));
    await h.settle();
    const digests = h.sends().slice(4);
    assert.equal(digests.length, 3, 'P, Q, R get ONE card each; S gets nothing');
    const byChat = new Map(digests.map((c) => [c.body.chat_id, c.body.text]));
    assert.ok(byChat.get('4400000101').includes('LAX.AS3.Pro.TINY') && !byChat.get('4400000101').includes('LAX.AS3.Pro.POCKET'), 'P: own plan only');
    assert.ok(byChat.get('4400000102').includes('LAX.AS3.Pro.POCKET') && !byChat.get('4400000102').includes('LAX.AS3.Pro.TINY'), 'Q: own plan only');
    assert.ok(byChat.get('4400000103').includes('LAX.AS3.Pro.TINY') && byChat.get('4400000103').includes('LAX.AS3.Pro.POCKET'), 'R: both');
    assert.equal(byChat.get('4400000104'), undefined, 'S: empty intersection = no message at all');
  } finally {
    await h.close();
  }
});

test('E2E-S3: staggered pushes inside one window coalesce; a fire after the close opens a second card', async () => {
  const h = await boot({ windowMs: 60 });
  try {
    await h.push(FIXTURE_STATE);
    await h.post('/api/subscribe', { token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['lax-as3-tiny', 'lax-as3-pocket', 'lax-as3-starter'] });
    // Two pushes a few ms apart, different plans — both inside the 60 ms window.
    await h.push(withStatus({ 'lax-as3-tiny': 'in' }));
    await h.push(withStatus({ 'lax-as3-tiny': 'in', 'lax-as3-pocket': 'in' }));
    await h.settle();
    let digests = h.sends().slice(1);
    assert.equal(digests.length, 1, 'ONE card carrying both');
    assert.ok(digests[0].body.text.includes('LAX.AS3.Pro.TINY') && digests[0].body.text.includes('LAX.AS3.Pro.POCKET'));
    // A third fire after the close → a second, separate card (window-scope honesty).
    await h.push(withStatus({ 'lax-as3-tiny': 'in', 'lax-as3-pocket': 'in', 'lax-as3-starter': 'in' }));
    await h.settle();
    digests = h.sends().slice(1);
    assert.equal(digests.length, 2, 'a second window, a second card');
    assert.ok(digests[1].body.text.includes('LAX.AS3.Pro.STARTER') && !digests[1].body.text.includes('LAX.AS3.Pro.TINY'), 'the late fire only');
  } finally {
    await h.close();
  }
});

test('E2E-S4: re-alert only after a confirmed OUT (armed semantics, R4)', async () => {
  const h = await boot();
  try {
    await h.push(FIXTURE_STATE);
    await h.post('/api/subscribe', { token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['lax-as3-tiny'] });
    await h.push(withStatus({ 'lax-as3-tiny': 'in' }));
    await h.settle();
    assert.equal(h.sends().length, 2, 'first digest');
    // IN → IN with no OUT between: zero.
    await h.push(withStatus({ 'lax-as3-tiny': 'in' }));
    await h.settle();
    assert.equal(h.sends().length, 2, 'no OUT between → no re-alert');
    // OUT re-arms, then IN fires exactly one NEW digest.
    await h.push(withStatus({ 'lax-as3-tiny': 'out' }));
    await h.push(withStatus({ 'lax-as3-tiny': 'in' }));
    await h.settle();
    assert.equal(h.sends().length, 3, 're-armed by the confirmed OUT → exactly one new digest');
  } finally {
    await h.close();
  }
});

test('E2E-S5: a crash between window close and dispatch never swallows the alert (boot re-drain); TTL expires stale rows', async () => {
  // Pass 1: the queued digest survives the crash and sends exactly once on reboot.
  const dirA = mkdtempSync(join(tmpdir(), 'dmit-sub-e2e-crash-'));
  const clock = { t: T0 };
  const a = await boot({ dir: dirA, clock });
  await a.push(FIXTURE_STATE);
  await a.post('/api/subscribe', { token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['lax-as3-tiny'] });
  a.tg.setScript(() => 'hang'); // Telegram wedged: the window closes, dispatch can't deliver
  await a.push(withStatus({ 'lax-as3-tiny': 'in' }));
  await a.settle();
  const dbA = a.db();
  const pending = dbA.prepare('SELECT sent_ts FROM digest_queue').get();
  dbA.close();
  assert.equal(pending.sent_ts, null, 'the row is enqueued but undelivered — the crash-safe outbox');
  await a.stop(); // "crash"

  clock.t = T0 + 10 * 60_000; // reboot 10 min later — inside the 30 min TTL
  const b = await boot({ dir: dirA, clock });
  await b.server.whenSubsIdle(); // boot re-drain
  const digests = b.sends();
  assert.equal(digests.length, 1, 'the queued digest sends exactly once (at-least-once delivery)');
  assert.ok(digests[0].body.text.includes('LAX.AS3.Pro.TINY'));
  await b.close();

  // Pass 2: the same crash but rebooted 31 min later → expired, zero sends.
  const dirB = mkdtempSync(join(tmpdir(), 'dmit-sub-e2e-ttl-'));
  const clock2 = { t: T0 };
  const c = await boot({ dir: dirB, clock: clock2 });
  await c.push(FIXTURE_STATE);
  await c.post('/api/subscribe', { token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['lax-as3-tiny'] });
  c.tg.setScript(() => 'hang');
  await c.push(withStatus({ 'lax-as3-tiny': 'in' }));
  await c.settle();
  await c.stop();

  clock2.t = T0 + 31 * 60_000;
  const d = await boot({ dir: dirB, clock: clock2 });
  await d.server.whenSubsIdle();
  assert.equal(d.sends().length, 0, 'a 31-min-old alert is worse than none — expired, never sent');
  const dbD = d.db();
  assert.equal(dbD.prepare('SELECT last_error FROM digest_queue').get().last_error, 'expired');
  dbD.close();
  await d.close();
  rmSync(dirA, { recursive: true, force: true });
});

test('E2E-S6: a bot revoked mid-life is disabled after ONE attempt and hears nothing ever again (R6)', async () => {
  const h = await boot();
  try {
    await h.push(FIXTURE_STATE);
    await h.post('/api/subscribe', { token: SUB_TOKEN, chatId: CHAT_ID, planIds: ['lax-as3-tiny', 'lax-as3-pocket'] });
    h.tg.setScript(() => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }));
    await h.push(withStatus({ 'lax-as3-tiny': 'in' }));
    await h.settle();
    assert.equal(h.sends().length, 2, 'exactly one delivery attempt for the revoked token');
    const db = h.db();
    assert.equal(db.prepare('SELECT disabled FROM subscribers').get().disabled, 1, 'disabled immediately');
    db.close();
    h.tg.setScript(null);
    // A second restock: the window-close enqueue skips disabled rows entirely.
    await h.push(withStatus({ 'lax-as3-pocket': 'in' }));
    await h.settle();
    assert.equal(h.sends().length, 2, 'the recorder gains zero calls for them');
  } finally {
    await h.close();
  }
});

test('E2E-S7: zero-subscriber steady state — windows open and close, edges are maintained, nothing is sent or queued', async () => {
  const h = await boot();
  try {
    await h.push(FIXTURE_STATE);
    await h.push(withStatus({ 'lax-as3-tiny': 'in' }));
    await h.settle();
    await h.push(withStatus({ 'lax-as3-tiny': 'out' }));
    await h.push(withStatus({ 'lax-as3-tiny': 'in' }));
    await h.settle();
    const db = h.db();
    const edge = db.prepare("SELECT * FROM plan_edges WHERE plan_id = 'lax-as3-tiny'").get();
    const queued = db.prepare('SELECT COUNT(*) AS n FROM digest_queue').get().n;
    db.close();
    assert.equal(edge.last_known, 'IN');
    assert.equal(edge.armed, 0, 'plan_edges maintained through both windows');
    assert.equal(queued, 0, 'zero queue rows');
    assert.equal(h.sends().length, 0, 'zero calls — the notifier idles clean (pairs with AUD-R2 ①)');
  } finally {
    await h.close();
  }
});
