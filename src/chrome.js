// CDP page-source: the ONLY thing that talks to the live store. We do NOT let
// Playwright launch Chrome — recon v3 proved a Playwright-launched browser gets
// Cloudflare-403'd even when headful. Instead we ATTACH (connectOverCDP) to a
// dedicated, already-running Chrome that scripts/start.sh launches HEADLESS
// (--headless=new, no visible window) with a realistic desktop User-Agent:
//
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --headless=new --user-agent="Mozilla/5.0 (Macintosh; …) Chrome/149… Safari/537.36" \
//     --user-data-dir="$HOME/.dmit-watch/chrome-profile" \
//     --remote-debugging-address=127.0.0.1 --remote-debugging-port=9444 \
//     --no-first-run --no-default-browser-check \
//     --remote-allow-origins=http://127.0.0.1:9444
//
// Reading stock is public (no DMIT login). --headless=new on the REAL Chrome
// binary with a non-Headless UA auto-clears the Cloudflare challenge (verified);
// the persistent profile stays CF-cleared on disk so steady loads usually skip
// it, and readFamily() below waits out a transient first-load/expiry challenge.
//
// IMPORTANT — exact-origin match: Chrome's --remote-allow-origins allowlist is an
// EXACT, case-sensitive scheme://host:port check against the Origin the CDP
// WebSocket handshake sends, which is derived from our connect `endpoint`. So the
// endpoint host MUST match the allow-origins host verbatim: both use 127.0.0.1
// (NOT localhost) here. A localhost↔127.0.0.1 mismatch makes the handshake 403
// and the watcher never reads. Do not use `*`.
//
// playwright-core is imported lazily so detect/watcher unit tests (which inject a
// fake page source) never need the dependency present.

const DEFAULT_CONTENT_TIMEOUT_MS = 20_000; // wait this long for a CF challenge to auto-clear
const DEFAULT_CONTENT_POLL_MS = 500;
// Budget for the generation-toggle fallback below: how long to wait for the
// family's generation box to be clickable, then for its cards to paint.
const DEFAULT_GEN_CLICK_TIMEOUT_MS = 5_000;
const DEFAULT_GEN_SWITCH_TIMEOUT_MS = 10_000;

// Positive "this is the real cart.php render" signals. Every cart render — sold
// out OR orderable — shows at least one of these. A transient Cloudflare
// interstitial ("Just a moment…", "Verifying you are human") contains NONE of
// them, so their continued absence means the challenge has not cleared yet.
const CART_CONTENT_MARKERS = Object.freeze([
  'out of stock',
  'sold out',
  'add to cart',
  'total due today',
  'instance scale',
]);

const lcIncludes = (text, needleLc) => String(text ?? '').toLowerCase().includes(needleLc);

/**
 * Pure: does this rendered text look like the real cart render (vs a CF
 * challenge / blank first paint)? Used to wait out a transient challenge before
 * reading stock. Exported for unit testing.
 * @param {string} pageText
 * @param {{ plans?: Array<{name?: string}> }} [opts]
 */
export function hasCartContent(pageText, { plans = [] } = {}) {
  const hay = String(pageText ?? '').toLowerCase();
  if (CART_CONTENT_MARKERS.some((m) => hay.includes(m))) return true;
  return plans.some((p) => p?.name && hay.includes(String(p.name).toLowerCase()));
}

/**
 * Pure: the "we are looking at THIS family's cards" token — every DMIT plan
 * name starts with `<LOC>.<GEN>.` (e.g. "HKG.AN5."). Null when the family
 * doesn't carry both fields (non-DMIT shapes don't), which disables the
 * generation-toggle fallback below. Exported for unit testing.
 */
export function familyNameToken(family) {
  const loc = family?.locCode;
  const gen = family?.genLabel;
  return loc && gen ? `${loc}.${gen}.`.toLowerCase() : null;
}

/** Build the per-family cart.php deep link (also the operator's Buy-now link). */
export function familyUrl(settings, family) {
  if (family?.deepLink) return family.deepLink;
  const base = (settings?.baseUrl ?? 'https://www.dmit.io').replace(/\/$/, '');
  const path = settings?.cartPath ?? '/cart.php';
  const region = family?.regionSlug ?? family?.loc;
  const network = settings?.network ?? 'premium';
  const generation = family?.gen;
  const language = settings?.language ?? 'english';
  return `${base}${path}?region=${region}&network=${network}&generation=${generation}&language=${language}`;
}

/**
 * A page source the watcher can drive: { readFamily(family), close() }.
 * Attaches once, keeps one warm tab, and re-attaches on a dropped connection.
 *
 * @returns {{ readFamily: (family) => Promise<{ok,status,pageText,error,chromeState}>,
 *   close: () => Promise<void>, familyUrl: (family) => string }}
 */
export function createCdpPageSource({
  // Must match Chrome's --remote-allow-origins exactly (127.0.0.1, not localhost).
  endpoint = 'http://127.0.0.1:9444',
  settings = {},
  navTimeoutMs = 25_000,
  // How long to let a transient CF challenge auto-clear before reading anyway.
  contentTimeoutMs = DEFAULT_CONTENT_TIMEOUT_MS,
  contentPollMs = DEFAULT_CONTENT_POLL_MS,
  genClickTimeoutMs = DEFAULT_GEN_CLICK_TIMEOUT_MS,
  genSwitchTimeoutMs = DEFAULT_GEN_SWITCH_TIMEOUT_MS,
  // Injectable for tests (clock, sleep, and the page connector).
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  connect,
  logger = console,
} = {}) {
  let browser = null;
  let page = null;

  // Default connector: lazily import playwright-core and ATTACH (never launch).
  const doConnect =
    connect ??
    (async () => {
      const { chromium } = await import('playwright-core');
      const br = await chromium.connectOverCDP(endpoint);
      const ctx = br.contexts()[0] ?? (await br.newContext());
      const pg = ctx.pages()[0] ?? (await ctx.newPage());
      return { browser: br, page: pg };
    });

  async function ensurePage() {
    if (page && !page.isClosed?.()) return page;
    const conn = await doConnect();
    browser = conn.browser;
    page = conn.page;
    return page;
  }

  function reset() {
    page = null;
    browser = null;
  }

  // Read body text, tolerating a mid-navigation failure. While Cloudflare's
  // challenge auto-clears it does a full client-side navigation that destroys the
  // execution context — an evaluate() racing into that throws ("Execution context
  // was destroyed…"). That is transient, NOT a dead page, so we swallow it to null
  // and let the wait loop re-poll; only goto/connect failures bubble to DOWN.
  async function safeReadBody(pg) {
    try {
      return await pg.evaluate(() => document.body?.innerText ?? '');
    } catch {
      return null;
    }
  }

  // DMIT deep-link bug (observed 2026-07-04 on the new HKG AN5 group, gid 30):
  // the cart ignores ?generation=<gen> for groups its deep-link JS doesn't map
  // and renders the region's DEFAULT generation instead — cart anchors all
  // present, zero expected plan names, so the family would sit UNKNOWN/blind
  // forever. The right generation's TOGGLE is still rendered (and visible —
  // hidden boxes belong to other regions), so when the cart is up but this
  // family's name token is absent, click the family's generation box and
  // re-poll until its cards paint. Every failure path (no token fields, box
  // absent/hidden, click timeout, cards never paint) falls through with the
  // text we already had — detect.js classifies that UNKNOWN exactly as before,
  // so a false IN stays structurally impossible.
  async function selectFamilyGeneration(pg, family, initialText) {
    const token = familyNameToken(family);
    if (!token) return initialText;
    let pageText = initialText;
    if (lcIncludes(pageText, token)) return pageText; // already on the right generation
    if (!hasCartContent(pageText)) return pageText; // not a cart render — nothing to click
    const genAttr = String(family.genLabel).replace(/"/g, '\\"');
    const boxSelector = `.server-generation-box[generation="${genAttr}"]:not(.hidden)`;
    try {
      await pg.click(boxSelector, { timeout: genClickTimeoutMs });
    } catch {
      return pageText; // box missing or unclickable — return what rendered
    }
    const deadline = now() + genSwitchTimeoutMs;
    while (!lcIncludes(pageText, token) && now() < deadline && !pg.isClosed?.()) {
      await sleep(contentPollMs);
      pageText = (await safeReadBody(pg)) ?? pageText;
    }
    return pageText;
  }

  async function readFamily(family) {
    const url = familyUrl(settings, family);
    try {
      const pg = await ensurePage();
      const resp = await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
      const status = resp?.status() ?? 0;

      // Do NOT bail on a non-2xx status: a first load or an expired clearance can
      // briefly show a Cloudflare interstitial (403/503) that --headless=new then
      // auto-solves, after which the page renders the real cart. Poll the rendered
      // text until the cart's own markers appear, capped at contentTimeoutMs. If
      // it never clears we return whatever rendered as-is — detect.js classifies
      // it UNKNOWN (never a false IN) and the blind-watcher net handles a
      // persistent failure exactly as before.
      const deadline = now() + contentTimeoutMs;
      let pageText = (await safeReadBody(pg)) ?? '';
      while (!hasCartContent(pageText) && now() < deadline && !pg.isClosed?.()) {
        await sleep(contentPollMs);
        pageText = (await safeReadBody(pg)) ?? pageText;
      }

      pageText = await selectFamilyGeneration(pg, family, pageText);

      // `ok` reflects whether we actually got a trustworthy cart render, not the
      // raw HTTP status (which may be the now-cleared challenge's 403/503).
      const ok = hasCartContent(pageText);
      return { ok, status, pageText, chromeState: 'UP' };
    } catch (err) {
      logger?.warn?.(`[chrome] read failed for ${family?.key}: ${err.message}`);
      reset(); // force a clean re-attach next cycle
      return { ok: false, status: 0, pageText: '', error: err.message, chromeState: 'DOWN' };
    }
  }

  async function close() {
    try {
      await browser?.close();
    } catch {
      /* already gone */
    }
    reset();
  }

  return { readFamily, close, familyUrl: (family) => familyUrl(settings, family) };
}
