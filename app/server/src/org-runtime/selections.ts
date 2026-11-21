import type { TxClient } from '../db.js';
import type { Profile } from './types.js';

export interface ProfileRevision { id: string; version: number }

/** The latest selection per target, preserving provenance through rollback. */
export async function selectedRuntimeProfiles(tx: TxClient) {
  return (await tx.query<{agent:string;selectionVersion:number;profile:ProfileRevision|null;definition:Profile|null}>(`
    SELECT DISTINCT ON(c->'target'->>'id') c->'target'->>'id' AS agent,
      v.version AS "selectionVersion", v.applied_profiles->(n::int-1) AS profile, p.definition
    FROM org_runtime_versions v
    CROSS JOIN LATERAL jsonb_array_elements(v.changes) WITH ORDINALITY AS x(c,n)
    LEFT JOIN org_runtime_profiles p ON p.id=v.applied_profiles->(n::int-1)->>'id'
      AND p.version=(v.applied_profiles->(n::int-1)->>'version')::int
    WHERE c->'target'->>'kind'='org-agent'
    ORDER BY c->'target'->>'id',v.version DESC`)).rows;
}
