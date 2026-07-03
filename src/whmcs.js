// WHMCS provider adapter (families with provider:"whmcs", e.g. qq.pw).
//
// WHMCS store-group pages are server-rendered with an EXPLICIT per-product
// stock badge — `<span class="qty">N Available</span>` — and (so far) no
// Cloudflare interstitial, so this provider needs neither the dedicated Chrome
// nor DMIT's control-group inference: qty > 0 is IN, qty = 0 is OUT, a missing
// badge/name is UNKNOWN (never promoted to IN) and feeds the same blind net.
//
// Mirrors the dmit split (detect.js pure classifier + chrome.js page source)
// in one small module: classifyWhmcsFamily is PURE (text in, results out);
// createHttpPageSource is the only impure part (fetch), fully injectable.

import { STOCK, cardSegment } from './detect.js';

const BLOCK_MARKERS = [
  'just a moment',
  'checking your browser',
  'verify you are human',
  'verifying you are human',
  'attention required',
];

const QTY_RE = /(\d[\d,]*)\s*Available\b/i;

const DEFAULT_TIMEOUT_MS = 20_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const lc = (s) => String(s ?? '').toLowerCase();

/**
 * Reduce an HTML document to the text flow the classifier reads — the same
 * shape Chrome's innerText gives the dmit detector, so fixtures and live reads
 * classify identically.
 */
export function htmlToText(html) {
  let text = String(html ?? '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<[^>]+>/g, '\n');
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * Classify every plan of a WHMCS family from the rendered page text (PURE).
 * Stock is the explicit "N Available" badge inside the plan's own card segment
 * (plan name → next plan name). Both IN and OUT are explicit numerals here, so
 * no control group is needed; anything unparseable is UNKNOWN.
 *
 * @returns same shape the watcher expects from classifyFamily:
 *   { markersPresent, blocked, loginWall, countMatch, namesFound, expectedCount,
 *     controlOutCount, results: Array<{id,name,stock,reason}> }
 */
export function classifyWhmcsFamily({ pageText, family, plans }) {
  const hay = lc(pageText);
  const blocked = BLOCK_MARKERS.some((m) => hay.includes(m));
  const namesFound = plans.filter((p) => hay.includes(lc(p.name))).length;
  const expectedCount = family?.planCount ?? plans.length;
  const countMatch = namesFound === expectedCount;
  // The structural anchor is a badge-shaped "N Available", not the bare word
  // ("…not available for this product" prose would false-anchor). Zero badges
  // page-wide means the store layout changed → markers-missing, never IN/OUT.
  const markersPresent = !blocked && namesFound > 0 && QTY_RE.test(String(pageText ?? ''));

  if (!markersPresent) {
    const reason = blocked ? 'blocked' : 'markers-missing';
    return {
      markersPresent: false,
      blocked,
      loginWall: false,
      countMatch: false,
      namesFound,
      expectedCount,
      controlOutCount: 0,
      results: plans.map((p) => ({ id: p.id, name: p.name, stock: STOCK.UNKNOWN, reason })),
    };
  }

  const names = plans.map((p) => p.name);
  const results = plans.map((p) => {
    const seg = cardSegment(pageText, p.name, names);
    if (seg == null) return { id: p.id, name: p.name, stock: STOCK.UNKNOWN, reason: 'card-missing' };
    const m = seg.match(QTY_RE);
    if (!m) return { id: p.id, name: p.name, stock: STOCK.UNKNOWN, reason: 'qty-missing' };
    const qty = Number.parseInt(m[1].replace(/,/g, ''), 10);
    return qty > 0
      ? { id: p.id, name: p.name, stock: STOCK.IN, reason: `qty:${qty}` }
      : { id: p.id, name: p.name, stock: STOCK.OUT, reason: 'qty:0' };
  });

  return {
    markersPresent: true,
    blocked: false,
    loginWall: false,
    countMatch,
    namesFound,
    expectedCount,
    controlOutCount: results.filter((r) => r.reason === 'qty:0').length,
    results,
  };
}

/**
 * A plain-HTTPS page source for WHMCS families: { readFamily(family), close() }.
 * Same read contract as createCdpPageSource. chromeState stays null so the
 * heartbeat's Chrome lamp is never touched by non-Chrome reads.
 */
export function createHttpPageSource({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = console,
} = {}) {
  async function readFamily(family) {
    const url = family?.url ?? family?.deepLink;
    if (!url) {
      return { ok: false, status: 0, pageText: '', error: 'family has no url', chromeState: null };
    }
    try {
      const resp = await fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, 'accept-language': 'en' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await resp.text();
      if (!resp.ok) {
        return { ok: false, status: resp.status, pageText: '', error: `http ${resp.status}`, chromeState: null };
      }
      return { ok: true, status: resp.status, pageText: htmlToText(body), chromeState: null };
    } catch (err) {
      logger?.warn?.(`[whmcs] read ${family?.key ?? '?'} failed: ${err.message}`);
      return { ok: false, status: 0, pageText: '', error: err.message, chromeState: null };
    }
  }

  return { readFamily, close: async () => {} };
}
