import { agentSpecProblem } from '../agent-spec.js';
import type { Assignment, Profile } from './types.js';

export function assignmentProblem(a: Assignment, caps: string[], p: Profile): string | null {
  const problem = agentSpecProblem(a);
  if (problem) return problem;
  if (['human','session'].includes(a.runtime)) return 'target needs an executable runtime';
  // Provider is metadata for provider/model IDs. Existing org dispatchers do not accept a separate provider override.
  if (a.provider && (!a.model?.startsWith(`${a.provider}/`) || !['hermes','zen-agent'].includes(a.runtime))) return 'provider must match the executable provider/model ID';
  const protectedCaps = ['code','review','merge','deploy'].filter(c => caps.includes(c));
  if (protectedCaps.length) {
    const m = a.model ? p.models[a.model] : undefined;
    const floor = protectedCaps.some(c => ['review','merge','deploy'].includes(c)) ? 3 : 2;
    if (!m?.canCode || m.tier < floor) return `capability floor ${floor} requires a declared coding model for ${protectedCaps.join(', ')}`;
  }
  return null;
}
