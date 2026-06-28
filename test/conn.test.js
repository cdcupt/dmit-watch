// Unit tests for the panel's SSE connection layer: the pure backoff math + state
// machine (public/js/conn.js) and the injectable EventSource wiring
// (public/js/sse.js). All DOM/EventSource/timer/RNG seams are faked, so the
// reconnect loop runs deterministically in plain Node — no jsdom.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONN, reconnectDelayMs, createConnectionMachine } from '../public/js/conn.js';
import { connectSse } from '../public/js/sse.js';

// ─────────────────────────── backoff schedule ───────────────────────────────

test('reconnectDelayMs: capped exponential 1s→2s→4s→8s→15s (rng=0, no jitter)', () => {
  const z = () => 0;
  assert.equal(reconnectDelayMs({ attempt: 1, rng: z }), 1000);
  assert.equal(reconnectDelayMs({ attempt: 2, rng: z }), 2000);
  assert.equal(reconnectDelayMs({ attempt: 3, rng: z }), 4000);
  assert.equal(reconnectDelayMs({ attempt: 4, rng: z }), 8000);
  assert.equal(reconnectDelayMs({ attempt: 5, rng: z }), 15_000); // 16s clamped to cap
  assert.equal(reconnectDelayMs({ attempt: 9, rng: z }), 15_000); // stays at the cap
});

test('reconnectDelayMs: jitter adds 0..jitterRatio of the base and never exceeds the cap', () => {
  // attempt 1, base 1000: rng=0 → 1000, rng→1 → ~1200 (≤ 1.2·base)
  assert.equal(reconnectDelayMs({ attempt: 1, rng: () => 0 }), 1000);
  const hi = reconnectDelayMs({ attempt: 1, rng: () => 0.999999 });
  assert.ok(hi > 1000 && hi <= 1200, `expected (1000,1200], got ${hi}`);
  // at the cap, even max jitter is clamped back to capMs
  assert.equal(reconnectDelayMs({ attempt: 20, rng: () => 0.999999 }), 15_000);
});

test('reconnectDelayMs: monotonic non-decreasing in attempt for a fixed RNG draw', () => {
  const rng = () => 0.5;
  let prev = -1;
  for (let attempt = 1; attempt <= 12; attempt++) {
    const ms = reconnectDelayMs({ attempt, rng });
    assert.ok(ms >= prev, `attempt ${attempt} (${ms}) < prev (${prev})`);
    assert.ok(ms <= 15_000, `attempt ${attempt} (${ms}) exceeded cap`);
    prev = ms;
  }
});

test('reconnectDelayMs: seeded RNG is deterministic; honours custom base/cap', () => {
  const a = reconnectDelayMs({ attempt: 3, rng: () => 0.37 });
  const b = reconnectDelayMs({ attempt: 3, rng: () => 0.37 });
  assert.equal(a, b);
  // custom knobs: base 500, cap 4000, attempt 4 → 500·2³=4000 (== cap)
  assert.equal(reconnectDelayMs({ attempt: 4, baseMs: 500, capMs: 4000, rng: () => 0 }), 4000);
});

// ─────────────────────────── state machine ──────────────────────────────────

test('createConnectionMachine: connecting → live → reconnecting → live transitions', () => {
  const seen = [];
  const m = createConnectionMachine({ onChange: (s) => seen.push(s) });

  assert.equal(m.state, CONN.CONNECTING); // initial, no onChange yet
  assert.equal(m.markOpen(), false); // first open is NOT a reopen
  assert.equal(m.state, CONN.LIVE);

  assert.equal(m.markDropped(), 1);
  assert.equal(m.state, CONN.RECONNECTING);
  assert.equal(m.markDropped(), 2); // attempt climbs, state unchanged
  assert.equal(m.state, CONN.RECONNECTING);

  assert.equal(m.markOpen(), true); // reopen after a drop → resync signal
  assert.equal(m.state, CONN.LIVE);
  assert.equal(m.attempt, 0); // backoff reset on open

  assert.deepEqual(seen, [CONN.LIVE, CONN.RECONNECTING, CONN.LIVE]); // one event per transition
});

// ─────────────────────────── sse.js wiring ──────────────────────────────────

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type, payload) {
    for (const fn of this.listeners[type] || []) fn(payload);
  }
  close() {
    this.closed = true;
  }
  static reset() {
    FakeEventSource.instances = [];
  }
  static last() {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }
}
FakeEventSource.instances = [];

function harness({ rng = () => 0 } = {}) {
  FakeEventSource.reset();
  const timers = [];
  const states = [];
  let resyncCalls = 0;
  let fetchCalls = 0;
  const handlers = {
    onState: (s) => states.push(s),
    onReconnect: () => {
      resyncCalls += 1;
      fetchCalls += 1; // stand-in for api.fetchState() — mocked here
    },
  };
  const deps = {
    EventSourceCtor: FakeEventSource,
    setTimer: (fn, ms) => {
      const h = { fn, ms };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h);
      if (i >= 0) timers.splice(i, 1);
    },
    rng,
  };
  const conn = connectSse(handlers, deps);
  return {
    conn,
    states,
    timers,
    get resyncCalls() {
      return resyncCalls;
    },
    get fetchCalls() {
      return fetchCalls;
    },
    flush() {
      const t = timers.shift();
      if (t) t.fn();
    },
  };
}

test('connectSse: emits connecting then live on first open, with NO resync', () => {
  const h = harness();
  assert.equal(h.states[0], CONN.CONNECTING);
  assert.equal(FakeEventSource.instances.length, 1);

  FakeEventSource.last().emit('open');
  assert.equal(h.conn.state, CONN.LIVE);
  assert.deepEqual(h.states, [CONN.CONNECTING, CONN.LIVE]);
  assert.equal(h.resyncCalls, 0); // a first open is not a reconnect
});

test('connectSse: drop → reconnecting + backoff timer; reopen → live + resync (mocked fetch)', () => {
  const h = harness({ rng: () => 0 });
  FakeEventSource.last().emit('open'); // live

  FakeEventSource.last().emit('error'); // stream drops
  assert.equal(h.conn.state, CONN.RECONNECTING);
  assert.equal(h.timers.length, 1, 'a single backoff timer is armed');
  assert.equal(h.timers[0].ms, 1000, 'first retry ≈ 1s');
  assert.equal(h.fetchCalls, 0, 'no resync while still down');

  h.flush(); // backoff elapses → a fresh EventSource is opened
  assert.equal(FakeEventSource.instances.length, 2);

  FakeEventSource.last().emit('open'); // reconnected
  assert.equal(h.conn.state, CONN.LIVE);
  assert.equal(h.resyncCalls, 1, 'reopen triggers exactly one resync');
  assert.equal(h.fetchCalls, 1, 'the resync fetched a fresh snapshot');
});

test('connectSse: repeated drops without a reopen walk the capped backoff schedule', () => {
  const h = harness({ rng: () => 0 });
  FakeEventSource.last().emit('open'); // live

  const expected = [1000, 2000, 4000, 8000, 15_000, 15_000];
  for (const ms of expected) {
    FakeEventSource.last().emit('error');
    assert.equal(h.timers[0].ms, ms, `expected backoff ${ms}`);
    h.flush(); // open a fresh stream that we will drop again (never markOpen)
  }
});

test('connectSse: duplicate error events do not stack timers or skip backoff levels', () => {
  const h = harness({ rng: () => 0 });
  FakeEventSource.last().emit('open');

  const es = FakeEventSource.last();
  es.emit('error');
  es.emit('error'); // a second error before the retry fires must be ignored
  es.emit('error');
  assert.equal(h.timers.length, 1, 'only one timer pending despite 3 errors');
  assert.equal(h.conn.attempt, 1, 'backoff level advanced once, not three times');
  assert.equal(h.timers[0].ms, 1000);
});

test('connectSse: forwards named events as parsed JSON and ignores malformed data', () => {
  FakeEventSource.reset();
  const got = [];
  connectSse(
    { snapshot: (d) => got.push(d), onState() {} },
    { EventSourceCtor: FakeEventSource, setTimer: () => 0, clearTimer() {}, rng: () => 0 },
  );
  const es = FakeEventSource.last();
  es.emit('open');
  es.emit('snapshot', { data: '{"counts":{"in":2}}' });
  es.emit('snapshot', { data: 'not json{' }); // dropped silently
  assert.deepEqual(got, [{ counts: { in: 2 } }]);
});

test('connectSse: close() stops the retry loop — no further reconnects', () => {
  const h = harness({ rng: () => 0 });
  FakeEventSource.last().emit('open');
  FakeEventSource.last().emit('error');
  assert.equal(h.timers.length, 1);

  h.conn.close();
  assert.equal(h.timers.length, 0, 'pending retry was cancelled');
  const before = FakeEventSource.instances.length;
  // a late error after close must not arm anything
  FakeEventSource.instances[before - 1].emit('error');
  assert.equal(h.timers.length, 0);
  assert.equal(FakeEventSource.instances.length, before);
});
