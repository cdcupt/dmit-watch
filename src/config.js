// Config loader: the git-tracked watchlist (public) and the runtime secrets
// (private, never committed/logged). Both validate at the boundary and fail fast.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { WATCHLIST_FILE, SECRETS_FILE } from './paths.js';

// Strict location/generation sets apply to the DMIT provider only; other
// providers (whmcs) carry free-form lowercase slugs plus a page url.
const VALID_LOCS = new Set(['lax', 'hkg', 'tyo']);
const VALID_GENS = new Set(['as3', 'an4', 'an5']);
const VALID_PROVIDERS = new Set(['dmit', 'whmcs']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// ---- poll cadence knob ----------------------------------------------------
// How often each plan is checked. The friendly form is a single number of
// seconds (settings.cadenceSec) — default 60 (one minute). A legacy [min,max]
// array is still accepted for power users (backward compat). The env var below
// is a quick override that wins over the file without editing it.
const DEFAULT_CADENCE_SEC = 60; // one check per plan per minute
const CADENCE_FLOOR_SEC = 20; // politeness floor — never poll faster than this
const CADENCE_JITTER_FRACTION = 0.1; // ±10% so the beat is never perfectly regular
const CADENCE_ENV = 'DMIT_WATCH_CADENCE_SEC';

/**
 * Load + validate config/watchlist.json (settings, families, 32 plans).
 * Never reads secrets. Throws with an actionable message on any structural fault.
 */
export function loadWatchlist(file = WATCHLIST_FILE) {
  if (!existsSync(file)) {
    throw new Error(`watchlist not found at ${file}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`watchlist is not valid JSON (${file}): ${err.message}`);
  }

  const { settings, families, plans } = parsed;
  if (!settings || typeof settings !== 'object') {
    throw new Error('watchlist.settings missing');
  }
  if (!Array.isArray(families) || families.length === 0) {
    throw new Error('watchlist.families must be a non-empty array');
  }
  if (!Array.isArray(plans) || plans.length === 0) {
    throw new Error('watchlist.plans must be a non-empty array');
  }

  const familyKeys = new Set(families.map((f) => f.key));
  const providerByFamily = new Map();
  for (const f of families) {
    const provider = f.provider ?? 'dmit';
    if (!VALID_PROVIDERS.has(provider)) {
      throw new Error(`family ${f.key} has unknown provider "${f.provider}"`);
    }
    if (provider !== 'dmit' && !f.url) {
      throw new Error(`family ${f.key} (provider ${provider}) requires a "url" to poll`);
    }
    providerByFamily.set(f.key, provider);
  }

  const seenIds = new Set();
  for (const p of plans) {
    for (const field of ['id', 'family', 'loc', 'gen', 'size', 'name', 'price', 'deepLink']) {
      if (p[field] === undefined || p[field] === null || p[field] === '') {
        throw new Error(`plan ${p.id ?? '(no id)'} missing required field "${field}"`);
      }
    }
    if (seenIds.has(p.id)) throw new Error(`duplicate plan id "${p.id}"`);
    seenIds.add(p.id);
    if (!familyKeys.has(p.family)) {
      throw new Error(`plan ${p.id} references unknown family "${p.family}"`);
    }
    if (providerByFamily.get(p.family) === 'dmit') {
      if (!VALID_LOCS.has(p.loc)) throw new Error(`plan ${p.id} has unknown loc "${p.loc}"`);
      if (!VALID_GENS.has(p.gen)) throw new Error(`plan ${p.id} has unknown gen "${p.gen}"`);
    } else {
      if (!SLUG_RE.test(p.loc)) throw new Error(`plan ${p.id} has invalid loc slug "${p.loc}"`);
      if (!SLUG_RE.test(p.gen)) throw new Error(`plan ${p.id} has invalid gen slug "${p.gen}"`);
    }
  }

  return parsed;
}

/** A single target (seconds) → a floor-clamped [min,max] jitter band (±10%). */
function bandFromTarget(targetSec, origin, warn) {
  let target = targetSec;
  if (target < CADENCE_FLOOR_SEC) {
    warn(`cadence ${target}s (${origin}) is below the ${CADENCE_FLOOR_SEC}s floor — clamping to ${CADENCE_FLOOR_SEC}s to stay polite`);
    target = CADENCE_FLOOR_SEC;
  }
  return [
    Math.round(target * (1 - CADENCE_JITTER_FRACTION)),
    Math.round(target * (1 + CADENCE_JITTER_FRACTION)),
  ];
}

/** Legacy [min,max] band → floor-clamped band, keeping the spread where possible. */
function clampBand([min, max], warn) {
  if (min < CADENCE_FLOOR_SEC) {
    warn(`cadence floor ${min}s is below the ${CADENCE_FLOOR_SEC}s floor — clamping to ${CADENCE_FLOOR_SEC}s to stay polite`);
    return [CADENCE_FLOOR_SEC, Math.max(max, CADENCE_FLOOR_SEC)];
  }
  return [min, max];
}

/**
 * Resolve the poll cadence into the canonical [minSec, maxSec] jitter band that
 * src/backoff.js consumes directly. This is the single place cadence is decided.
 *
 * Precedence (highest first):
 *   1. env DMIT_WATCH_CADENCE_SEC — a positive number; a quick knob, no file edit
 *   2. settings.cadenceSec — a single number (friendly: target seconds between
 *      checks per plan) OR a legacy [min,max] array (power users / backward compat)
 *   3. the built-in default (60s)
 *
 * A single number N becomes [N·0.9, N·1.1] (~±10% jitter) for politeness. The
 * target is clamped to a 20s floor (CADENCE_FLOOR_SEC) so the watcher can never be
 * told to hammer Cloudflare. A bad value (≤0, non-numeric, malformed array) NEVER
 * crashes: it warns and falls back to the default.
 *
 * @param {object} [settings] watchlist.settings (reads settings.cadenceSec)
 * @param {{ env?: object, logger?: object }} [opts]
 * @returns {[number, number]} [minSec, maxSec]
 */
export function resolveCadenceSec(settings = {}, { env = process.env, logger = console } = {}) {
  const warn = (msg) => logger?.warn?.(`[config] ${msg}`);

  // 1. env override — wins over the file when it parses to a positive number.
  const envRaw = env?.[CADENCE_ENV];
  if (envRaw !== undefined && envRaw !== null && String(envRaw).trim() !== '') {
    const n = Number(envRaw);
    if (Number.isFinite(n) && n > 0) return bandFromTarget(n, CADENCE_ENV, warn);
    warn(`${CADENCE_ENV}="${envRaw}" is not a positive number — ignoring it, using config/watchlist.json`);
  }

  // 2. file value — single number (friendly) or legacy [min,max] array.
  const raw = settings.cadenceSec;
  if (typeof raw === 'number') {
    if (Number.isFinite(raw) && raw > 0) return bandFromTarget(raw, 'settings.cadenceSec', warn);
    warn(`settings.cadenceSec=${raw} is not a positive number — using default ${DEFAULT_CADENCE_SEC}s`);
    return bandFromTarget(DEFAULT_CADENCE_SEC, 'default', warn);
  }
  if (Array.isArray(raw)) {
    const [min, max] = raw;
    if (raw.length === 2 && Number.isFinite(min) && min > 0 && Number.isFinite(max) && max > 0 && min <= max) {
      return clampBand([min, max], warn);
    }
    warn(`settings.cadenceSec=${JSON.stringify(raw)} is not a valid [min,max] band — using default ${DEFAULT_CADENCE_SEC}s`);
    return bandFromTarget(DEFAULT_CADENCE_SEC, 'default', warn);
  }
  if (raw !== undefined) {
    warn(`settings.cadenceSec (${JSON.stringify(raw)}) is not a number or [min,max] array — using default ${DEFAULT_CADENCE_SEC}s`);
  }

  // 3. default — no file value present.
  return bandFromTarget(DEFAULT_CADENCE_SEC, 'default', warn);
}

/** Recompute the informational _meta.counts block from the current plans. */
function recomputeMeta(meta, plans) {
  const byLocation = {};
  const byGeneration = {};
  for (const p of plans) {
    const loc = String(p.loc).toUpperCase();
    const gen = String(p.gen).toUpperCase();
    byLocation[loc] = (byLocation[loc] ?? 0) + 1;
    byGeneration[gen] = (byGeneration[gen] ?? 0) + 1;
  }
  return { ...(meta ?? {}), counts: { ...(meta?.counts ?? {}), total: plans.length, byLocation, byGeneration } };
}

/**
 * Pure transform: drop one family (and all its plans) from a watchlist, returning
 * a NEW object (never mutates the input). Throws if the key is absent or the
 * removal would empty the watchlist (config.js's own validation forbids that).
 */
export function removeFamilyFromWatchlist(watchlist, familyKey) {
  const families = (watchlist.families ?? []).filter((f) => f.key !== familyKey);
  if (families.length === (watchlist.families ?? []).length) {
    throw new Error(`family "${familyKey}" is not in the watchlist`);
  }
  const plans = (watchlist.plans ?? []).filter((p) => p.family !== familyKey);
  if (families.length === 0 || plans.length === 0) {
    throw new Error('refusing to remove the last watched family');
  }
  return { ...watchlist, _meta: recomputeMeta(watchlist._meta, plans), families, plans };
}

/** Write a watchlist back to disk (pretty JSON + trailing newline). */
export function writeWatchlist(watchlist, file = WATCHLIST_FILE) {
  writeFileSync(file, `${JSON.stringify(watchlist, null, 2)}\n`, 'utf8');
}

/** Parse a KEY=VALUE env-style file, ignoring blanks and # comments. */
function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

/**
 * Load Telegram secrets from ~/.dmit-watch/config (KEY=VALUE).
 * process.env overrides file values. Secret VALUES are never logged.
 * @param {{ required?: boolean }} opts when required (default), throws if either secret is absent.
 * @returns {{ botToken: string|undefined, chatId: string|undefined }}
 */
export function loadSecrets({ required = true } = {}) {
  let fileVals = {};
  if (existsSync(SECRETS_FILE)) {
    fileVals = parseEnvFile(readFileSync(SECRETS_FILE, 'utf8'));
  }
  const botToken = process.env.TELEGRAM_BOT_TOKEN || fileVals.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || fileVals.TELEGRAM_CHAT_ID;

  if (required) {
    const missing = [];
    if (!botToken) missing.push('TELEGRAM_BOT_TOKEN');
    if (!chatId) missing.push('TELEGRAM_CHAT_ID');
    if (missing.length) {
      throw new Error(
        `missing secret(s) ${missing.join(', ')} — set them in ${SECRETS_FILE} (chmod 600) or the environment`,
      );
    }
  }
  return { botToken, chatId };
}
