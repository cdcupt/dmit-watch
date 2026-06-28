// EventSource('/events') wiring with an OWNED reconnect loop. The browser's
// EventSource auto-reconnects on its own schedule and gives us no insight into the
// connection state, so instead we close it on error and drive reconnection
// ourselves via a capped, jittered backoff (js/conn.js) — that way we always KNOW
// whether the panel is live or stale and can surface it (handlers.onState).
//
// On every real RE-open (a reconnect after a drop) we call handlers.onReconnect so
// the app re-fetches a full /api/state snapshot — the panel catches up instead of
// trusting deltas it may have missed while the stream was down. (The server also
// replays a `snapshot` on connect, so this is belt-and-suspenders.)
//
// All browser dependencies (EventSource, timers, RNG) are injectable so the whole
// reconnect/backoff/state machine is unit-testable in plain Node.

import { CONN, reconnectDelayMs, createConnectionMachine } from './conn.js';

const NAMED = ['snapshot', 'plan', 'alert', 'watcher', 'history'];

/**
 * @param {object} handlers
 *   per-event handlers (snapshot|plan|alert|watcher|history), plus:
 *   onState(state)  — 'connecting' | 'live' | 'reconnecting' on every transition
 *   onReconnect()   — fired after a stream RE-open so the app can resync
 *   onError()       — fired on each transport error (before the backoff is armed)
 * @param {object} [deps] injected seams (defaults wire the real browser)
 * @param {Function} [deps.EventSourceCtor]
 * @param {Function} [deps.setTimer]  (fn, ms) => handle
 * @param {Function} [deps.clearTimer](handle) => void
 * @param {() => number} [deps.rng]
 * @param {object} [deps.backoff] { baseMs, capMs, factor, jitterRatio }
 * @returns {{ state: string, attempt: number, close: () => void }}
 */
export function connectSse(handlers = {}, deps = {}) {
  const {
    EventSourceCtor = typeof EventSource !== 'undefined' ? EventSource : null,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    rng = Math.random,
    backoff = {},
  } = deps;

  const machine = createConnectionMachine({ onChange: (s) => handlers.onState?.(s) });
  let es = null;
  let retryHandle = null;
  let closed = false;

  function attach(source) {
    source.addEventListener('open', () => {
      if (machine.markOpen()) handlers.onReconnect?.(); // resync after a real drop
    });
    for (const name of NAMED) {
      source.addEventListener(name, (e) => {
        let data;
        try {
          data = JSON.parse(e.data);
        } catch {
          return;
        }
        handlers[name]?.(data);
      });
    }
    source.addEventListener('error', () => {
      handlers.onError?.();
      scheduleReconnect();
    });
  }

  function open() {
    if (closed || !EventSourceCtor) return;
    es = new EventSourceCtor('/events');
    attach(es);
  }

  // Take over reconnection: close the dead stream and arm a single backoff timer.
  // Repeat `error` events while a retry is already pending are ignored, so the
  // backoff level advances once per reconnect cycle, not once per error.
  function scheduleReconnect() {
    if (closed || retryHandle != null) return;
    try {
      es?.close();
    } catch {
      /* ignore */
    }
    const attempt = machine.markDropped();
    const delay = reconnectDelayMs({ attempt, rng, ...backoff });
    retryHandle = setTimer(() => {
      retryHandle = null;
      open();
    }, delay);
  }

  handlers.onState?.(machine.state); // emit the initial 'connecting'
  open();

  return {
    get state() {
      return machine.state;
    },
    get attempt() {
      return machine.attempt;
    },
    close() {
      closed = true;
      if (retryHandle != null) {
        clearTimer(retryHandle);
        retryHandle = null;
      }
      try {
        es?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

export { CONN };
