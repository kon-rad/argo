import type { TxClient } from '../db.js';
import { agentSpecProblem } from '../agent-spec.js';
import { OrgError } from '../org-error.js';
import { assignmentProblem } from './resolve.js';
import { selectedRuntimeProfiles } from './selections.js';

/** Imports keep overrides, and must validate the pair and new capabilities they will actually expose. */
export async function guardRuntimeImport(tx: TxClient, agents: Record<string, {runtime:string;model?:string;capabilities?:string[]}>) {
  await tx.query('LOCK TABLE org_agents, org_agent_overrides IN SHARE ROW EXCLUSIVE MODE');
  const overrides = (await tx.query<{agent:string;runtime:string|null;model:string|null;effort:string|null}>('SELECT agent,runtime,model,effort FROM org_agent_overrides')).rows;
  const selected = await selectedRuntimeProfiles(tx);
  for (const [name,a] of Object.entries(agents)) {
    const o = overrides.find(o => o.agent === name);
    const effective = {runtime:o?.runtime ?? a.runtime,model:o?.model ?? a.model ?? null,provider:null};
    let problem = agentSpecProblem({...effective,effort:o?.effort});
    const selection = selected.find(s => s.agent === name);
    if (selection && !selection.definition) throw new OrgError(`${name}: selection metadata unavailable`);
    const profile = selection?.definition;
    if (!problem && profile) problem = assignmentProblem(effective,a.capabilities ?? [],profile);
    if (problem) throw new OrgError(`${name}: ${problem}`);
  }
}
