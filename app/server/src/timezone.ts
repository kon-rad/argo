/**
 * The vault's current time zone (docs/timezone.md): one IANA name in `secondbrain.json` (`"timezone"`) that the
 * web app uses for every time it shows and for the Usage page's hour and day buckets. Set it when travelling with
 * `secondbrain timezone set <Area/City>`. Unset: each browser uses its own zone. Never inferred from the server's
 * zone, which says where the machine is, not where its owner is.
 */
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { settingsPath } from './settings.js';

/** A real IANA zone name the runtime knows (`Asia/Singapore`, `UTC`); not an offset or an abbreviation. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The runtime's spelling of a zone (`asia/singapore` -> `Asia/Singapore`), or null when it is not a zone. */
export function canonicalTimeZone(tz: string): string | null {
  if (!isTimeZone(tz)) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
}

/** The `timezone` value of a secondbrain.json text: null when the file has none or it is not a valid zone. */
export function timezoneOf(jsonText: string | null): string | null {
  if (!jsonText || !jsonText.trim()) return null;
  try {
    const v = (JSON.parse(jsonText) as { timezone?: unknown }).timezone;
    return isTimeZone(v) ? v : null;
  } catch {
    return null;
  }
}

/** secondbrain.json with `timezone` set (or removed for null), every other key left as it was. */
export function withTimezone(jsonText: string | null, tz: string | null): string {
  const root: Record<string, unknown> = jsonText && jsonText.trim() ? JSON.parse(jsonText) : {};
  if (typeof root !== 'object' || root === null || Array.isArray(root)) throw new Error('secondbrain.json is not a JSON object');
  if (tz === null) delete root.timezone;
  else root.timezone = tz;
  return JSON.stringify(root, null, 2) + '\n';
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The configured zone, read from the file on every call (it is small) so a change made with the CLI shows on the
 * next page load without restarting the server. Null: not set, or not a valid zone.
 */
export function currentTimezone(path = settingsPath()): string | null {
  try {
    return timezoneOf(readText(path));
  } catch {
    return null;
  }
}

/** Writes the zone into secondbrain.json (atomically: a temp file then a rename). Returns the canonical name. */
export function saveTimezone(tz: string | null, path = settingsPath()): string | null {
  const name = tz === null ? null : canonicalTimeZone(tz);
  if (tz !== null && !name) throw new Error(`not an IANA time zone: ${tz} (use a name like America/Los_Angeles or Asia/Singapore)`);
  const next = withTimezone(readText(path), name);
  let mode = 0o600;
  try { mode = statSync(path).mode & 0o777; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // A private sibling directory prevents following a pre-existing temporary-file symlink.
  // Keep the rename on the same filesystem, and restore the original mode despite umask.
  const directory = mkdtempSync(join(dirname(path), '.timezone-'));
  const tmp = join(directory, 'settings');
  try {
    writeFileSync(tmp, next, { mode, flag: 'wx' });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  return name;
}
