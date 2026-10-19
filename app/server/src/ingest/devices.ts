import { createHash, randomBytes } from 'node:crypto';
import { query } from '../db.js';

/**
 * A device is one machine's ledger. Its bearer token is shown once at creation and
 * stored only as a sha256 hash; the token's row names the usage_hosts slug every
 * batch from it is written as.
 */
export interface Device { id: number; host: string; label: string | null; createdAt: Date; lastSeenAt: Date | null; revokedAt: Date | null }

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');
const TOKEN = /^sbd_[A-Za-z0-9_-]{43}$/;

export async function addDevice(host: string, opts: { label?: string; display?: string; kind?: string } = {}): Promise<{ id: number; token: string }> {
  const known = await query(`SELECT 1 FROM usage_hosts WHERE slug=$1`, [host]);
  if (!known.rowCount) {
    if (!opts.display || !opts.kind) throw new Error(`unknown host "${host}": pass --display "<name>" --kind laptop|server|pi to register it`);
    await query(`INSERT INTO usage_hosts (slug, display, kind) VALUES ($1, $2, $3)`, [host, opts.display, opts.kind]);
  }
  const token = `sbd_${randomBytes(32).toString('base64url')}`;
  const { rows } = await query<{ id: number }>(
    `INSERT INTO ingest_devices (host, label, token_hash) VALUES ($1, $2, $3) RETURNING id`, [host, opts.label ?? null, hash(token)]);
  return { id: Number(rows[0]!.id), token };
}

/** The live device for a bearer token, or null. Touches last_seen_at at most once a minute. */
export async function findDevice(token: string): Promise<{ id: number; host: string } | null> {
  if (!TOKEN.test(token)) return null;
  const { rows } = await query<{ id: number; host: string }>(
    `UPDATE ingest_devices SET last_seen_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING id, host`, [hash(token)]);
  return rows[0] ? { id: Number(rows[0].id), host: rows[0].host } : null;
}

export async function listDevices(): Promise<Device[]> {
  const { rows } = await query<Device>(
    `SELECT id, host, label, created_at AS "createdAt", last_seen_at AS "lastSeenAt", revoked_at AS "revokedAt"
     FROM ingest_devices ORDER BY id`);
  return rows;
}

export async function revokeDevice(id: number): Promise<boolean> {
  const r = await query(`UPDATE ingest_devices SET revoked_at = now() WHERE id=$1 AND revoked_at IS NULL`, [id]);
  return (r.rowCount ?? 0) > 0;
}
