import { query as appQuery } from '../../../db.js';
import type { PublicationEntry, PublicationLedger, ReserveResult } from './swarm.js';

type Row = Record<string, unknown> & {
  idempotency_key: string; claim_ref: string; artifact_hash: string; media_type: string;
  public_destination: string; public_ref: string | null; delivery_ref: string | null;
  status: PublicationEntry['status'];
};
export type PublicationQuery = <T extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) => Promise<{ rows: T[] }>;
function entry(row: Row): PublicationEntry {
  return { key: row.idempotency_key, claimRef: row.claim_ref,
    binding: { artifactHash: row.artifact_hash, mediaType: row.media_type, publicDestination: row.public_destination },
    status: row.status, ...(row.public_ref ? { publicRef: row.public_ref } : {}), ...(row.delivery_ref ? { deliveryRef: row.delivery_ref } : {}) };
}
function key(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 200) throw new Error('Invalid publication key');
}

/** Atomic immutable checkpoints; no private key, upload or chain publication authority. */
export class PgPublicationLedger implements PublicationLedger {
  constructor(private readonly query: PublicationQuery = appQuery) {}

  async reserve(input: Parameters<PublicationLedger['reserve']>[0]): Promise<ReserveResult> {
    key(input.key);
    const { binding } = input;
    if (!input.claimRef || input.claimRef.length > 500 || !/^sha256:[0-9a-f]{64}$/.test(binding.artifactHash) || binding.mediaType !== 'text/markdown' || !binding.publicDestination || binding.publicDestination.length > 500) throw new Error('Invalid publication binding');
    const inserted = await this.query<Row>(`INSERT INTO desk_publications
      (idempotency_key, claim_ref, artifact_hash, media_type, public_destination)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [input.key, input.claimRef, binding.artifactHash, binding.mediaType, binding.publicDestination]);
    if (inserted.rows[0]) return { kind: 'reserved', entry: entry(inserted.rows[0]) };
    // A separate statement gets a fresh READ COMMITTED snapshot after a competing insert commits.
    const current = await this.get(input.key);
    if (!current) return { kind: 'in-flight' };
    if (current.claimRef !== input.claimRef || current.binding.artifactHash !== binding.artifactHash || current.binding.mediaType !== binding.mediaType || current.binding.publicDestination !== binding.publicDestination) return { kind: 'conflict' };
    return { kind: 'existing', entry: current };
  }

  async recordUpload(id: string, publicRef: string): Promise<PublicationEntry> {
    key(id);
    if (!/^[0-9a-f]{64}$/.test(publicRef)) throw new Error('Invalid public Swarm reference');
    const result = await this.query<Row>(`UPDATE desk_publications SET public_ref=$2,
      status=CASE WHEN status='reserved' THEN 'uploaded' ELSE status END, updated_at=now()
      WHERE idempotency_key=$1 AND (public_ref IS NULL OR public_ref=$2) RETURNING *`, [id, publicRef]);
    if (!result.rows[0]) throw new Error('Publication upload conflicts or reservation is missing');
    return entry(result.rows[0]);
  }

  async recordDelivery(id: string, deliveryRef: string): Promise<PublicationEntry> {
    key(id);
    if (!deliveryRef || deliveryRef.length > 500) throw new Error('Invalid delivery reference');
    const result = await this.query<Row>(`UPDATE desk_publications SET delivery_ref=$2,
      status='delivered', updated_at=now() WHERE idempotency_key=$1 AND public_ref IS NOT NULL
      AND (delivery_ref IS NULL OR delivery_ref=$2) RETURNING *`, [id, deliveryRef]);
    if (!result.rows[0]) throw new Error('Publication delivery conflicts or upload is missing');
    return entry(result.rows[0]);
  }

  async get(id: string): Promise<PublicationEntry | null> {
    key(id);
    const result = await this.query<Row>('SELECT * FROM desk_publications WHERE idempotency_key=$1', [id]);
    return result.rows[0] ? entry(result.rows[0]) : null;
  }
}
