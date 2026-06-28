// Hardened request-body reader for the panel server's state-changing POSTs.
// Extracted from server.js so the limit/timeout logic stays small and unit-focused:
// a malformed, oversized, or stalled body must produce a clean HTTP status (not a
// hung request, a killed socket, or an unhandledRejection that takes the always-on
// process down). The server awaits readJsonBody inside its router try/catch.

export const MAX_BODY_BYTES = 64 * 1024;
export const BODY_READ_TIMEOUT_MS = 10_000;

// Boundary error carrying the HTTP status the router should reply with: a bad body
// (413/400/408) maps cleanly while anything unexpected falls through to 500. We
// only reject INTO an awaited caller, so it never becomes an unhandledRejection.
function bodyError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// Read + parse a JSON body with hard limits so a malformed, oversized, or stalled
// POST can never hang the request or wedge the always-on process: over
// MAX_BODY_BYTES → 413 (stops accumulating), invalid JSON → 400, no body within
// timeoutMs → 408. Settles exactly once; the awaited router turns it into an HTTP
// response (later stream events are ignored).
export function readJsonBody(req, timeoutMs = BODY_READ_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, bodyError(408, 'request body read timed out')), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        finish(reject, bodyError(413, 'request body too large')); // stop reading
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return finish(resolve, {});
      try {
        finish(resolve, JSON.parse(raw));
      } catch {
        finish(reject, bodyError(400, 'invalid JSON body'));
      }
    });
    req.on('error', (err) => finish(reject, err));
  });
}
