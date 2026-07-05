// Unit tests for board-server/rate-limit.js (round-2 TECH §Q1.6, RL-U1…U5):
// fixed 1 h windows with exact Retry-After, window expiry, X-Forwarded-For
// first-hop keying with socket fallback, independent bucket families, and
// sweep hygiene. Pure module — the clock is injected everywhere; the module's
// own sweep interval is unref'd (this suite exiting cleanly is the proof).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { clientIp, createFixedWindowLimiter } from '../board-server/rate-limit.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-07-05T12:00:00.000Z');

const makeLimiter = (clock) => createFixedWindowLimiter({ now: () => clock.t });

test('RL-U1: fixed window counts — limit 5/h admits 5, rejects the 6th with exact retryAfterSec', () => {
  const clock = { t: T0 };
  const limiter = makeLimiter(clock);
  for (let i = 0; i < 5; i++) assert.deepEqual(limiter.check('ip:203.0.113.7', 5), { ok: true });
  clock.t = T0 + 10 * 60_000; // 10 min into the window
  const rejected = limiter.check('ip:203.0.113.7', 5);
  assert.equal(rejected.ok, false);
  // Seconds to the END of the fixed window (opened at T0), not a flat constant.
  assert.equal(rejected.retryAfterSec, (HOUR - 10 * 60_000) / 1000);
  limiter.stop();
});

test('RL-U2: window expiry resets — the same key admits again with a fresh windowStart', () => {
  const clock = { t: T0 };
  const limiter = makeLimiter(clock);
  assert.equal(limiter.check('k', 2).ok, true);
  assert.equal(limiter.check('k', 2).ok, true);
  assert.equal(limiter.check('k', 2).ok, false);
  clock.t = T0 + HOUR; // exactly one window later
  assert.equal(limiter.check('k', 2).ok, true, 'fresh window admits');
  assert.equal(limiter.check('k', 2).ok, true);
  const again = limiter.check('k', 2);
  assert.equal(again.ok, false);
  assert.equal(again.retryAfterSec, HOUR / 1000, 'windowStart moved to the fresh window');
  limiter.stop();
});

test('RL-U3: XFF keying — first hop wins, distinct first hops are distinct buckets, absent header falls back to the socket', () => {
  const req = (xff) => ({
    headers: xff == null ? {} : { 'x-forwarded-for': xff },
    socket: { remoteAddress: '172.18.0.1' },
  });
  assert.equal(clientIp(req('203.0.113.7, 10.0.0.1')), '203.0.113.7'); // first hop, trimmed
  assert.equal(clientIp(req(' 198.51.100.9 ')), '198.51.100.9');
  assert.notEqual(clientIp(req('203.0.113.7, 10.0.0.1')), clientIp(req('198.51.100.9')));
  assert.equal(clientIp(req(null)), '172.18.0.1'); // absent header → socket address
  assert.equal(clientIp(req('')), '172.18.0.1'); // empty header → socket address

  const clock = { t: T0 };
  const limiter = makeLimiter(clock);
  assert.equal(limiter.check(`ip:${clientIp(req('203.0.113.7, 10.0.0.1'))}`, 1).ok, true);
  assert.equal(limiter.check(`ip:${clientIp(req('203.0.113.7, 10.0.0.1'))}`, 1).ok, false, 'same first hop = same bucket');
  assert.equal(limiter.check(`ip:${clientIp(req('198.51.100.9'))}`, 1).ok, true, 'distinct first hop = distinct bucket');
  limiter.stop();
});

test('RL-U4: independent bucket families — exhausting the IP family never consumes the token-hash family', () => {
  const clock = { t: T0 };
  const limiter = makeLimiter(clock);
  const ip = '203.0.113.7';
  const tokenHash = createHash('sha256').update('8000000001:TESTSENTINELTOKENxxxxxxxxxxxxxxxx').digest('hex');
  // The same logical request drives both buckets (the server namespaces keys).
  assert.equal(limiter.check(`subscribe-ip:${ip}`, 1).ok, true);
  assert.equal(limiter.check(`subscribe-tok:${tokenHash}`, 2).ok, true);
  assert.equal(limiter.check(`subscribe-ip:${ip}`, 1).ok, false, 'IP family exhausted');
  assert.equal(limiter.check(`subscribe-tok:${tokenHash}`, 2).ok, true, 'token family untouched by the IP rejection');
  limiter.stop();
});

test('RL-U5: sweep hygiene — expired buckets are evicted and the Map shrinks', () => {
  const clock = { t: T0 };
  const limiter = makeLimiter(clock);
  for (let i = 0; i < 10; i++) limiter.check(`ip:10.0.0.${i}`, 5);
  limiter.check('fresh-key', 5);
  assert.equal(limiter.size(), 11);
  clock.t = T0 + HOUR + 1; // every bucket above is now expired
  limiter.check('fresh-key', 5); // re-opens this one in the new window
  limiter.sweep();
  assert.equal(limiter.size(), 1, 'only the still-live bucket survives the sweep');
  limiter.stop();
});

// The sweep interval must be unref'd (an armed timer never holds the process
// open — the publisher/server discipline). Deliberately NOT stopped: this
// suite exiting cleanly IS the assertion.
test('RL-U5b: an un-stopped limiter never holds the process open (unref discipline)', () => {
  const limiter = createFixedWindowLimiter({});
  assert.equal(limiter.check('k', 1).ok, true);
});
