/**
 * The vault's configured time zone (docs/timezone.md): an IANA location or UTC in `secondbrain.json` (`"timezone"`),
 * exposed by the metadata API for frontend display and Usage bucketing. Set it when travelling with
 * `secondbrain timezone set <Area/City>`. Unset: each browser uses its own zone. Never inferred from the server's
 * zone, which says where the machine is, not where its owner is.
 */
import { closeSync, fchmodSync, fchownSync, fstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import { isIanaTimeZone, settingsPath } from './settings.js';

/** A real IANA zone name the runtime knows (`Asia/Singapore`, `UTC`); not an offset or an abbreviation. */
export const isTimeZone = isIanaTimeZone;

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
  let original: Stats | undefined;
  try { original = statSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // A private sibling directory prevents following a pre-existing temporary-file symlink.
  // Keep the rename on the same filesystem, and restore the original mode despite umask.
  const directory = mkdtempSync(join(dirname(path), '.timezone-'));
  const tmp = join(directory, 'settings');
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, next);
    if (original) {
      // A replacement owned by the CLI caller could revoke the service's access.
      // Fail before rename if this caller cannot retain the original identity.
      try { fchownSync(fd, original.uid, original.gid); }
      catch (error) { throw new Error('cannot preserve settings ownership; original file unchanged', { cause: error }); }
      // chown can clear permission bits, so restore them afterwards.
      fchmodSync(fd, original.mode & 0o777);
      const actual = fstatSync(fd);
      if (actual.uid !== original.uid || actual.gid !== original.gid || (actual.mode & 0o777) !== (original.mode & 0o777)) {
        throw new Error('cannot preserve settings identity and permissions; original file unchanged');
      }
    }
    closeSync(fd); fd = undefined;
    renameSync(tmp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(directory, { recursive: true, force: true });
  }
  return name;
}
