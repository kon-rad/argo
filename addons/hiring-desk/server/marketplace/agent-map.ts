/**
 * Trusted, owner-configured mapping from immutable Cybazaar identities to local org agents.
 *
 * The map comes from server configuration (CYBAZAAR_AGENT_MAP), never from marketplace data.
 * Display names in listing snapshots are untrusted and are never used to pick an assignee.
 */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const agentName = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface AgentMapEntry { listingId?: string; agentId?: string; localAgent: string }
export type AgentMapping =
  | { state: 'mapped'; localAgent: string }
  | { state: 'missing' | 'ambiguous' | 'conflict'; reason: string };

/** Parses the configured JSON array. Invalid configuration fails at boot instead of guessing. */
export function parseAgentMap(raw: string | undefined): AgentMapEntry[] {
  if (raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('CYBAZAAR_AGENT_MAP must be a JSON array.'); }
  if (!Array.isArray(parsed) || parsed.length > 500) throw new Error('CYBAZAAR_AGENT_MAP must be a JSON array of at most 500 entries.');
  return parsed.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`CYBAZAAR_AGENT_MAP entry ${index} must be an object.`);
    const entry = value as Record<string, unknown>;
    const extra = Object.keys(entry).filter(key => !['listingId', 'agentId', 'localAgent'].includes(key));
    if (extra.length) throw new Error(`CYBAZAAR_AGENT_MAP entry ${index} has unknown keys.`);
    const listingId = typeof entry.listingId === 'string' ? entry.listingId.toLowerCase() : undefined;
    const agentId = typeof entry.agentId === 'string' ? entry.agentId.toLowerCase() : undefined;
    if (entry.listingId !== undefined && (!listingId || !uuid.test(listingId))) throw new Error(`CYBAZAAR_AGENT_MAP entry ${index} has an invalid listingId.`);
    if (entry.agentId !== undefined && (!agentId || !uuid.test(agentId))) throw new Error(`CYBAZAAR_AGENT_MAP entry ${index} has an invalid agentId.`);
    if (!listingId && !agentId) throw new Error(`CYBAZAAR_AGENT_MAP entry ${index} needs a listingId or an agentId.`);
    if (typeof entry.localAgent !== 'string' || !agentName.test(entry.localAgent)) throw new Error(`CYBAZAAR_AGENT_MAP entry ${index} has an invalid localAgent.`);
    return { ...(listingId ? { listingId } : {}), ...(agentId ? { agentId } : {}), localAgent: entry.localAgent };
  });
}

/**
 * Resolves the local assignee for one request. Every entry whose keys all match is a candidate;
 * zero distinct agents is missing, more than one is ambiguous. A request whose identity changed
 * after import is a conflict and is never assigned.
 */
export function resolveAgent(map: readonly AgentMapEntry[], request: { listingId: string; agentId: string | null; identityConflict?: boolean }): AgentMapping {
  if (request.identityConflict) return { state: 'conflict', reason: 'Cybazaar reported a different listing, agent or requester for this request after it was imported.' };
  const listingId = request.listingId.toLowerCase(), agentId = request.agentId?.toLowerCase() ?? null;
  const candidates = map.filter(entry => (entry.listingId === undefined || entry.listingId === listingId) && (entry.agentId === undefined || entry.agentId === agentId));
  const agents = [...new Set(candidates.map(entry => entry.localAgent))];
  if (agents.length === 1) return { state: 'mapped', localAgent: agents[0]! };
  if (agents.length > 1) return { state: 'ambiguous', reason: `Listing ${listingId}${agentId ? ` and Cybazaar agent ${agentId}` : ''} map to more than one local agent (${agents.join(', ')}).` };
  const listingOnlyForOtherAgent = map.some(entry => entry.listingId === listingId && entry.agentId !== undefined && entry.agentId !== agentId);
  if (listingOnlyForOtherAgent) return { state: 'missing', reason: `Listing ${listingId} is mapped only for a different Cybazaar agent than this request${agentId ? ` (${agentId})` : ' (agent identity not supplied)'}.` };
  return { state: 'missing', reason: `No local agent is mapped for listing ${listingId}${agentId ? ` or Cybazaar agent ${agentId}` : ''}. Add it to CYBAZAAR_AGENT_MAP.` };
}
