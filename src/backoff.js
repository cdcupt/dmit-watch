// PURE jitter + exponential-backoff math for the scheduler (TECH §07, §16).
//
// No I/O, no clock, no module-level RNG — the RNG is injected, so every value is
// reproducible in a unit test (TECH "Seeded RNG injected into jitter/backoff").
// The watcher (src/watcher.js) is the only caller; it passes the live backoff
// level for a family and the default `Math.random` in production.

const DEFAULT_CADENCE = Object.freeze([60, 90]);
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_BACKOFF_CAP_SEC = 900;

/**
 * Next poll delay (ms) for one family.
 *   base   = uniform jitter in [min, max] seconds
 *   delay  = min(base · factorⁿ, cap)
 * where n = backoff level (0 on a healthy read). Monotonic in `level`, clamped at
 * the cap, and never below the cadence floor.
 *
 * @param {object} opts
 * @param {[number,number]} [opts.cadenceSec] [min, max] base cadence in seconds
 * @param {number} [opts.backoffFactor]       exponential base (default 2)
 * @param {number} [opts.backoffCapSec]       hard ceiling in seconds (default 900)
 * @param {number} [opts.level]               current backoff level (≥0)
 * @param {() => number} [opts.rng]           [0,1) source; injected for determinism
 * @returns {number} delay in milliseconds
 */
export function nextDelayMs({
  cadenceSec = DEFAULT_CADENCE,
  backoffFactor = DEFAULT_BACKOFF_FACTOR,
  backoffCapSec = DEFAULT_BACKOFF_CAP_SEC,
  level = 0,
  rng = Math.random,
} = {}) {
  const [min, max] = cadenceSec;
  const span = Math.max(0, max - min);
  const base = (min + rng() * span) * 1000;
  const factor = Math.pow(backoffFactor, Math.max(0, level));
  const cap = backoffCapSec * 1000;
  return Math.min(base * factor, cap);
}

export { DEFAULT_CADENCE };
