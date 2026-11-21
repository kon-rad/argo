import type { TxClient } from '../db.js';
import { agentSpecProblem } from '../agent-spec.js';
import { OrgError } from '../org-error.js';
import { assignmentProblem } from './resolve.js';
import type { Profile } from './types.js';

/** Imports keep overrides, and must validate the pair and new capabilities they will actually expose. */
export async function guardRuntimeImport(tx: TxClient, agents: Record<string, {runtime:string;model?:string;capabilities?:string[]}>) {
  await tx.query('LOCK TABLE org_agents, org_agent_overrides IN SHARE ROW EXCLUSIVE MODE');
  const overrides = (await tx.query<{agent:string;runtime:string|null;model:string|null;effort:string|null}>('SELECT agent,runtime,model,effort FROM org_agent_overrides')).rows;
  const selected = (await tx.query<{agent:string;definition:Profile}>(`
    SELECT DISTINCT ON(c->'target'->>'id') c->'target'->>'id' AS agent,p.definition
    FROM org_runtime_versions v JOIN org_runtime_profiles p ON p.id=v.profile_id AND p.version=v.profile_version,
    LATERAL jsonb_array_elements(v.changes) c
    WHERE c->'target'->>'kind'='org-agent'
    ORDER BY c->'target'->>'id',v.version DESC`)).rows;
  for (const [name,a] of Object.entries(agents)) {
    const o = overrides.find(o => o.agent === name);
    const effective = {runtime:o?.runtime ?? a.runtime,model:o?.model ?? a.model ?? null,provider:null};
    let problem = agentSpecProblem({...effective,effort:o?.effort});
    const profile = selected.find(s => s.agent === name)?.definition;
    if (!problem && profile) problem = assignmentProblem(effective,a.capabilities ?? [],profile);
    if (problem) throw new OrgError(`${name}: ${problem}`);
  }
}
