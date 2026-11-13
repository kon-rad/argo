import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONFIG_ENV_KEYS } from '../src/config.js';
import { ALL_MANIFESTS } from '../src/features/registry.js';

/**
 * Phase 4's env-schema test (card t_3d4ce863): every `process.env` key read anywhere in
 * the app is listed, so a new stray read fails the build instead of silently inventing a
 * setting with no default and no docs. The ground truth is config.ts's zod schema.
 */
const here = dirname(fileURLToPath(import.meta.url));
/** The app's own source: server/src and bin (the launcher's node helpers). */
const SCAN_DIRS = [resolve(here, '..', 'src'), resolve(here, '..', '..', 'bin')];
const SOURCE_EXT = /\.(ts|mjs|js)$/;
const READ = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\])/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'dist' ? [] : sourceFiles(path);
    return SOURCE_EXT.test(entry.name) ? [path] : [];
  });
}

/** key -> the first file that reads it. */
function envReads(): Map<string, string> {
  const found = new Map<string, string>();
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(dir)) {
      for (const m of readFileSync(file, 'utf8').matchAll(READ)) {
        const key = m[1] ?? m[2];
        if (key && !found.has(key)) found.set(key, file);
      }
    }
  }
  return found;
}

const KNOWN = new Set<string>(CONFIG_ENV_KEYS);

describe('env schema', () => {
  it('lists every process.env key read in the app (schema or documented baseline)', () => {
    const offenders = [...envReads()]
      .filter(([key]) => !KNOWN.has(key))
      .map(([key, file]) => `${key} (${file})`);
    expect(offenders).toEqual([]);
  });

  it('covers every key a feature manifest declares', () => {
    const offenders = [...new Set(ALL_MANIFESTS.flatMap((m) => m.env))].filter((key) => !KNOWN.has(key));
    expect(offenders).toEqual([]);
  });

});
