// Centralized filesystem paths for dmit-watch.
//
// Two roots are kept strictly separate:
//   - the repo (code + git-tracked config/watchlist.json, NO secrets)
//   - the runtime dir ~/.dmit-watch (git-ignored: secrets + SQLite db + chrome profile)
//
// Every path is overridable via env so tests never touch the real runtime dir.

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** Repo root (one level up from src/). */
export const REPO_ROOT = join(SRC_DIR, '..');

/** Git-tracked watchlist (28 plans + cadence). Never holds secrets. */
export const WATCHLIST_FILE =
  process.env.DMIT_WATCH_WATCHLIST || join(REPO_ROOT, 'config', 'watchlist.json');

/** Static panel assets served by the localhost server (index.html + js/ + css/). */
export const PUBLIC_DIR =
  process.env.DMIT_WATCH_PUBLIC || join(REPO_ROOT, 'public');

/** Runtime dir — git-ignored, chmod 700 in production. */
export const RUNTIME_DIR =
  process.env.DMIT_WATCH_DIR || join(homedir(), '.dmit-watch');

/** KEY=VALUE secrets file (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID), chmod 600. */
export const SECRETS_FILE =
  process.env.DMIT_WATCH_SECRETS || join(RUNTIME_DIR, 'config');

/** SQLite database file (+ -wal / -shm siblings in WAL mode). */
export const DB_FILE =
  process.env.DMIT_WATCH_DB || join(RUNTIME_DIR, 'dmit-watch.db');
