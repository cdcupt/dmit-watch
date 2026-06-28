// Shared test/smoke helpers: load fixtures + build a fake injectable page source.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Read a fixture file by name (e.g. "all-out.txt"). */
export function readFixture(name) {
  return readFileSync(join(FIX_DIR, name), 'utf8');
}

/**
 * A fake page source for the watcher: returns scripted reads per family key.
 * @param scripts map familyKey -> read object OR () => read object.
 *   A read is { ok, status?, pageText?, error?, chromeState? }; a bare string is
 *   treated as { ok:true, status:200, pageText:string }.
 */
export function makeFixtureSource(scripts = {}) {
  const norm = (v) =>
    typeof v === 'string' ? { ok: true, status: 200, pageText: v, chromeState: 'UP' } : v;
  return {
    async readFamily(family) {
      const entry = scripts[family.key];
      const val = typeof entry === 'function' ? entry(family) : entry;
      if (val == null) return { ok: false, status: 0, pageText: '', error: 'no-script', chromeState: 'DOWN' };
      return norm(val);
    },
    async close() {},
  };
}
