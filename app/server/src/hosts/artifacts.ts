import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { artifactMaxBytes, artifactRef, type ArtifactRef } from '@secondbrain/contracts/hosts';
import { HostServiceError } from './service.js';

type DB = Pool | PoolClient;
export const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const manifest = 'id::text,sha256,octet_length(content) AS bytes';

export function verifyArtifact(content: Buffer, expected: string) {
  if (content.length > artifactMaxBytes) throw new HostServiceError(413, 'Artifact exceeds the size limit');
  if (sha256(content) !== expected) throw new HostServiceError(422, 'Artifact digest mismatch');
}

export async function storeInput(db: DB, content: Buffer, expected: string): Promise<ArtifactRef> {
  verifyArtifact(content, expected);
  await db.query('DELETE FROM hc_artifacts WHERE expires_at <= now()');
  const { rows } = await db.query(`INSERT INTO hc_artifacts(id,sha256,content) VALUES($1,$2,$3) RETURNING ${manifest}`,
    [randomUUID(), expected, content]);
  return artifactRef.parse(rows[0]);
}

export async function requireInput(db: DB, input: ArtifactRef): Promise<void> {
  const result = await db.query(`SELECT 1 FROM hc_artifacts WHERE id=$1 AND sha256=$2 AND octet_length(content)=$3
    AND run_id IS NULL AND expires_at > now()`, [input.id, input.sha256, input.bytes]);
  if (!result.rowCount) throw new HostServiceError(404, 'Input artifact unavailable');
}

// These operations run under the registry transaction that authenticates the host.
export async function leasedInputContent(db: DB, machine: string, attempt: string, generation: number) {
  const { rows } = await db.query(`SELECT a.content FROM hc_requests r JOIN hc_artifacts a
    ON a.id::text=r.input_ref->>'id' WHERE r.attempt_id=$1 AND r.machine=$2 AND r.generation=$3
    AND r.state='reserved' AND a.expires_at > now() FOR SHARE OF r`, [attempt, machine, generation]);
  if (!rows[0]) throw new HostServiceError(404, 'Input unavailable for this lease');
  return rows[0].content as Buffer;
}

export async function storeOutput(db: DB, machine: string, attempt: string, generation: number, content: Buffer, expected: string) {
  verifyArtifact(content, expected);
  const { rows } = await db.query(`INSERT INTO hc_artifacts(id,sha256,content,run_id,generation)
    SELECT $1,$2,$3,r.id,r.generation FROM hc_requests r WHERE r.attempt_id=$4 AND r.generation=$5 AND r.machine=$6
    AND r.state='running' AND r.input_ref IS NOT NULL FOR SHARE OF r
    ON CONFLICT(run_id,generation) DO UPDATE SET sha256=excluded.sha256 WHERE hc_artifacts.sha256=excluded.sha256
    RETURNING ${manifest}`, [randomUUID(), expected, content, attempt, generation, machine]);
  if (!rows[0]) throw new HostServiceError(409, 'Output conflicts with the active lease');
  return artifactRef.parse(rows[0]);
}

export async function resultContent(db: DB, run: string) {
  const { rows } = await db.query(`SELECT a.content FROM hc_requests r JOIN hc_artifacts a
    ON a.id::text=r.result->'output'->>'id' AND a.run_id=r.id AND a.generation=r.generation
    WHERE r.id=$1 AND r.caller_id='owner' AND r.state='succeeded' AND a.expires_at>now()`, [run]);
  if (!rows[0]) throw new HostServiceError(404, 'Result file unavailable');
  return rows[0].content as Buffer;
}
