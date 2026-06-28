// Tiny DOM + formatting helpers shared across the panel modules.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const now = () => Date.now();

/** Escape text for safe interpolation into innerHTML (defence in depth). */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

/** "12s ago" / "3m 04s ago" from a millisecond delta. */
export function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

/** Compact uptime "4d 02:14" / "02:14:07". */
export function fmtUptime(ms) {
  if (ms == null) return '—';
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return d > 0 ? `${d}d ${h}:${m}` : `${h}:${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Family key → display label: "lax/as3" → "LAX·AS3" (datacenter·family). */
export function famLabel(key) {
  if (!key) return '';
  return String(key)
    .split('/')
    .filter(Boolean)
    .map((s) => s.toUpperCase())
    .join('·');
}

/** Local HH:MM:SS clock for a timestamp. */
export const clock = (t) =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const reduceMotion = () =>
  !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
