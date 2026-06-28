// PURE connection-state machine + reconnect backoff for the panel's SSE link.
//
// No EventSource, no timers, no DOM, no module-level RNG — every value is injected
// so the whole thing is reproducible in a plain-Node unit test (mirrors the watcher
// side, src/backoff.js). js/sse.js wires this to the browser EventSource + setTimeout.
//
// The three states the app cares about:
//   connecting    — first attempt, no stream yet (boot)
//   live          — stream open and delivering
//   reconnecting  — stream dropped; we are backing off + retrying
// Only `live` means the panel is showing fresh data; anything else is stale-risk.

export const CONN = Object.freeze({
  CONNECTING: 'connecting',
  LIVE: 'live',
  RECONNECTING: 'reconnecting',
});

const DEFAULTS = Object.freeze({
  baseMs: 1000, // first retry ~1s
  capMs: 15_000, // backoff ceiling ~15s
  factor: 2, // exponential base
  jitterRatio: 0.2, // ±0..20% added jitter so reconnects de-sync
});

/**
 * Next reconnect delay (ms) after `attempt` consecutive drops (attempt ≥ 1).
 *   base  = min(baseMs · factor^(attempt-1), capMs)        // capped exponential
 *   delay = min(base + base · jitterRatio · rng(), capMs)  // additive jitter, clamped
 * Monotonic non-decreasing in `attempt`, never below `baseMs`, never above `capMs`.
 *
 * @param {object} o
 * @param {number} [o.attempt]      consecutive failure count (1-based)
 * @param {number} [o.baseMs]
 * @param {number} [o.capMs]
 * @param {number} [o.factor]
 * @param {number} [o.jitterRatio]
 * @param {() => number} [o.rng]    [0,1) source; injected for determinism
 * @returns {number} delay in milliseconds
 */
export function reconnectDelayMs({
  attempt = 1,
  baseMs = DEFAULTS.baseMs,
  capMs = DEFAULTS.capMs,
  factor = DEFAULTS.factor,
  jitterRatio = DEFAULTS.jitterRatio,
  rng = Math.random,
} = {}) {
  const exp = baseMs * Math.pow(factor, Math.max(0, attempt - 1));
  const base = Math.min(exp, capMs);
  const jittered = base + base * jitterRatio * rng();
  return Math.min(Math.round(jittered), capMs);
}

/**
 * A tiny state machine for the connection lifecycle. Pure: it holds `state` and a
 * consecutive-drop `attempt` counter and notifies `onChange` only on a real
 * transition. The caller drives it with markOpen()/markDropped().
 *
 * @param {object} [o]
 * @param {(state: string) => void} [o.onChange] fired once per state transition
 */
export function createConnectionMachine({ onChange = () => {} } = {}) {
  let state = CONN.CONNECTING;
  let attempt = 0; // consecutive drops since the last successful open
  let opened = false; // have we ever seen the stream open?

  function set(next) {
    if (next === state) return;
    state = next;
    onChange(state);
  }

  return {
    get state() {
      return state;
    },
    get attempt() {
      return attempt;
    },
    /**
     * The transport opened. Resets the backoff. Returns true when this is a
     * RE-open after a prior drop (the app should resync a full snapshot, since
     * deltas may have been missed during the gap).
     */
    markOpen() {
      const isReopen = opened;
      opened = true;
      attempt = 0;
      set(CONN.LIVE);
      return isReopen;
    },
    /** The transport errored/closed. Bumps the backoff level; returns it. */
    markDropped() {
      attempt += 1;
      set(CONN.RECONNECTING);
      return attempt;
    },
  };
}
