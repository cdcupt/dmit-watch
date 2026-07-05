// Tiny DOM + formatting helpers for the public board. Copied subset of the
// panel's public/js/util.js (drops fmtUptime/famLabel/clock — operator-only);
// adds fmtDur() for the card since-lines. Pure at import time (no DOM reads).

export const $ = (sel, root = document) => root.querySelector(sel);

/** Escape text for safe interpolation into innerHTML (defence in depth). */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

/** "12s ago" / "3m 04s ago" from a millisecond delta — the freshness pill. */
export function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

/** Compact duration "38s" / "26m" / "2h 14m" / "3d 4h" — card since-lines. */
export function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export const reduceMotion = () =>
  !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
