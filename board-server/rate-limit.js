// Zero-dep fixed-window rate limiter for the subscription routes (round-2
// TECH §B3). In-memory Map buckets {count, windowStart}; fixed 1 h windows;
// rejections carry retryAfterSec = seconds to window end. Buckets are swept by
// an unref'd interval (the publisher/server timer discipline) so an armed
// sweep never holds the process open. Restart resets windows — acceptable: the
// subscriber cap and the D3 confirmation gate still hold.
//
// IP keying uses the FIRST hop of X-Forwarded-For (fallback: the socket
// address). The container only ever sees Caddy's Docker-gateway IP — socket
// keying would throttle all humans as one client; the first XFF hop is
// trustworthy here because the host port map is loopback-only and Caddy (the
// sole ingress) strips client-supplied XFF by default. Guard: never add
// trusted_proxies to this vhost's Caddy config.

const DEFAULT_WINDOW_MS = 3_600_000; // fixed 1 h windows (§B3)
const DEFAULT_SWEEP_MS = 600_000; // 10-min eviction sweep, unref'd

/** First X-Forwarded-For hop, else the socket address (§B3 keying rule). */
export function clientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string') {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * @param {object} opts
 * @param {() => number} [opts.now]     injectable clock (RL tests)
 * @param {number} [opts.windowMs]
 * @param {number} [opts.sweepEveryMs]
 * @returns {{check(key:string, limit:number): {ok:boolean, retryAfterSec?:number},
 *   sweep(): void, stop(): void, size(): number}}
 */
export function createFixedWindowLimiter({
  now = Date.now,
  windowMs = DEFAULT_WINDOW_MS,
  sweepEveryMs = DEFAULT_SWEEP_MS,
} = {}) {
  const buckets = new Map(); // key → {count, windowStart}

  /**
   * Count one hit against `key`. Callers namespace keys per bucket family
   * (e.g. 'subscribe-ip:1.2.3.4' vs 'subscribe-tok:<sha256>') so exhausting
   * one family never consumes another (RL-U4).
   */
  function check(key, limit) {
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket || t - bucket.windowStart >= windowMs) {
      bucket = { count: 0, windowStart: t };
      buckets.set(key, bucket);
    }
    if (bucket.count >= limit) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.windowStart + windowMs - t) / 1000));
      return { ok: false, retryAfterSec };
    }
    bucket.count += 1;
    return { ok: true };
  }

  /** Evict every expired bucket (also runs on the unref'd interval). */
  function sweep() {
    const t = now();
    for (const [key, bucket] of buckets) {
      if (t - bucket.windowStart >= windowMs) buckets.delete(key);
    }
  }

  const interval = setInterval(sweep, sweepEveryMs);
  interval.unref?.(); // never holds the process open (RL-U5)

  return { check, sweep, stop: () => clearInterval(interval), size: () => buckets.size };
}
