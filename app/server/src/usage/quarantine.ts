import { query } from '../db.js';
import { importLines } from './importer.js';
import type { Host } from '../archive/types.js';

export async function listQuarantine(host: string, limit = 100) {
  const { rows } = await query(`SELECT host,digest,reason,received_at,origin_path,octet_length(wire) bytes
    FROM usage_import_quarantine WHERE host=$1 ORDER BY received_at,digest LIMIT $2`, [host, Math.max(1, Math.min(1000, limit))]);
  return rows;
}

/** Deliberately returns metadata only. Transcript payloads never reach diagnostic output. */
export async function inspectQuarantine(host: string, digest: string) {
  const { rows } = await query(`SELECT host,digest,reason,received_at,origin_path,octet_length(wire) bytes
    FROM usage_import_quarantine WHERE host=$1 AND digest=$2`, [host, digest]);
  return rows[0] ?? null;
}

/** Optional repaired wire is still parsed, validated and imported through the supported importer.
 * Only acceptance deletes the original. A new rejection or operational error keeps it intact.
 */
export async function replayQuarantine(host: Host, digest: string, repairedWire?: string): Promise<boolean> {
  const { rows } = await query('SELECT wire FROM usage_import_quarantine WHERE host=$1 AND digest=$2', [host, digest]);
  if (!rows[0]) return false;
  const wire = repairedWire ?? String(rows[0].wire);
  if (wire.trim().split('\n').length !== 1) throw new Error('replay requires one wire item');
  const result = await importLines([wire], host);
  if (result.accepted.length !== 1 || result.rejected.length) return false;
  await query('DELETE FROM usage_import_quarantine WHERE host=$1 AND digest=$2', [host, digest]);
  return true;
}
