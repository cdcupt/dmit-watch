// Scheduler wiring tests — a fake watcher (EventEmitter) + a mock notifier.
// Proves edge→telegram, fresh blind is panel-only (broadcast yes, telegram NO)
// while ESCALATED blind (persisted past blindEscalateSec) reaches telegram,
// rearm is state-only (no telegram), the panel broadcast hook fires for every
// event, and start/stop wire + unwire.
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createScheduler } from '../src/scheduler.js';

const silent = { log() {}, warn() {}, error() {} };

/** A stand-in for the real watcher: an emitter with start/stop + a started flag. */
function fakeWatcher() {
  const em = new EventEmitter();
  const w = {
    started: false,
    on: em.on.bind(em),
    off: em.off.bind(em),
    emit: em.emit.bind(em),
    listenerCount: em.listenerCount.bind(em),
    start() { this.started = true; },
    async stop() { this.started = false; },
  };
  return w;
}

/** A mock notifier that records calls and resolves a settled result. */
function mockNotifier() {
  const edges = [];
  const blinds = [];
  return {
    edges,
    blinds,
    async notifyEdge(arg) { edges.push(arg); return { ok: true, attempts: 1 }; },
    async notifyBlind(arg) { blinds.push(arg); return { ok: true, attempts: 1 }; },
  };
}

const PLAN = { id: 'lax-an5-mini', name: 'LAX.AN5.Pro.MINI', price: '$79.90' };
const FAMILY = { key: 'lax/an5', label: 'LAX·AN5', city: 'Los Angeles', genLabel: 'AN5', cpu: 'EPYC 9005' };
const DEEP_LINK = 'https://www.dmit.io/cart.php?region=los-angeles&network=premium&generation=an5&language=english';

test('an OUT→IN edge routes to telegram and to the panel broadcast', async () => {
  const watcher = fakeWatcher();
  const notifier = mockNotifier();
  const events = [];
  const sched = createScheduler({
    watcher, notifier, broadcast: (e, p) => events.push([e, p]), logger: silent,
  });
  sched.start();
  assert.equal(watcher.started, true);

  watcher.emit('edge', { plan: PLAN, family: FAMILY, deepLink: DEEP_LINK });
  await sched.whenIdle();

  assert.equal(notifier.edges.length, 1);
  assert.equal(notifier.edges[0].plan.id, 'lax-an5-mini');
  assert.equal(notifier.edges[0].deepLink, DEEP_LINK);
  assert.ok(events.some(([e]) => e === 'edge'));
});

test('fresh blind (entry + throttled re-notify) is panel-only: broadcast yes, telegram NO', async () => {
  const watcher = fakeWatcher();
  const notifier = mockNotifier();
  const events = [];
  const sched = createScheduler({
    watcher, notifier, broadcast: (e, p) => events.push([e, p]), logger: silent,
  });
  sched.start();

  // entry, then a throttled re-notify (the watcher re-emits 'blind' while it persists), then recovery
  watcher.emit('blind', { family: FAMILY, reasons: ['persistent-block'], escalate: false, sinceMs: 1000 });
  watcher.emit('blind', { family: FAMILY, reasons: ['persistent-block'], escalate: false, sinceMs: 1000 });
  watcher.emit('blind:cleared', { family: FAMILY });
  await sched.whenIdle();

  // A FRESH blind never buzzes the phone — panel noise until it persists.
  assert.equal(notifier.blinds.length, 0);
  assert.equal(notifier.edges.length, 0);

  // ...but the panel/SSE/Watcher-health blind signal STILL fires (entry + re-notify),
  // and recovery is reflected on the panel too.
  const blindBroadcasts = events.filter(([e]) => e === 'blind');
  assert.equal(blindBroadcasts.length, 2);
  assert.equal(blindBroadcasts[0][1].family.key, 'lax/an5');
  assert.ok(events.some(([e]) => e === 'blind:cleared'));
});

test('ESCALATED blind (persisted past blindEscalateSec) reaches telegram with the duration', async () => {
  const watcher = fakeWatcher();
  const notifier = mockNotifier();
  const events = [];
  const sched = createScheduler({
    watcher, notifier, broadcast: (e, p) => events.push([e, p]), logger: silent,
  });
  sched.start();

  watcher.emit('blind', { family: FAMILY, reasons: ['persistent-unknown'], escalate: true, sinceMs: 12345 });
  await sched.whenIdle();

  assert.equal(notifier.blinds.length, 1);
  assert.equal(notifier.blinds[0].family.key, 'lax/an5');
  assert.deepEqual(notifier.blinds[0].reasons, ['persistent-unknown']);
  assert.equal(notifier.blinds[0].sinceMs, 12345);
  // The panel broadcast still fires alongside the telegram escalation.
  assert.equal(events.filter(([e]) => e === 'blind').length, 1);
});

test('a re-arm (IN→OUT) is state-only: broadcast yes, telegram no', async () => {
  const watcher = fakeWatcher();
  const notifier = mockNotifier();
  const events = [];
  const sched = createScheduler({ watcher, notifier, broadcast: (e) => events.push(e), logger: silent });
  sched.start();

  watcher.emit('rearm', { plan: PLAN, family: FAMILY, durationInStock: 120 });
  await sched.whenIdle();

  assert.equal(notifier.edges.length, 0);
  assert.equal(notifier.blinds.length, 0);
  assert.ok(events.includes('rearm'));
});

test('family/cycle/error events all reach the panel broadcast', async () => {
  const watcher = fakeWatcher();
  const events = [];
  const sched = createScheduler({
    watcher, notifier: mockNotifier(), broadcast: (e) => events.push(e), logger: silent,
  });
  sched.start();

  watcher.emit('family', { family: 'lax/an5', outcome: 'ok' });
  watcher.emit('cycle', { ts: 1, families: [] });
  watcher.emit('error', { family: FAMILY, error: new Error('boom') });
  await sched.whenIdle();

  assert.ok(events.includes('family'));
  assert.ok(events.includes('cycle'));
  assert.ok(events.includes('error'));
});

test('stop unwires every watcher listener and halts the watcher', async () => {
  const watcher = fakeWatcher();
  const notifier = mockNotifier();
  const sched = createScheduler({ watcher, notifier, logger: silent });
  sched.start();
  assert.ok(watcher.listenerCount('edge') >= 1);

  await sched.stop();
  assert.equal(watcher.started, false);
  assert.equal(watcher.listenerCount('edge'), 0);

  // events after stop are ignored (no telegram)
  watcher.emit('edge', { plan: PLAN, family: FAMILY, deepLink: DEEP_LINK });
  await sched.whenIdle();
  assert.equal(notifier.edges.length, 0);
});

test('heartbeat uptime is stamped at start when a store is provided', () => {
  const watcher = fakeWatcher();
  const calls = [];
  const store = { touchHeartbeat: (arg) => calls.push(arg) };
  const sched = createScheduler({ watcher, notifier: mockNotifier(), store, logger: silent });
  sched.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chromeSession, 'STARTING');
});
