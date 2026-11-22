/** Browser client for the owner-gated /api/desk/cybazaar routes. The integration secret never reaches the browser. */
export type RequestStatus = 'submitted' | 'accepted' | 'rejected' | 'in_progress' | 'revision_requested' | 'completed' | 'cancelled';
export type DeskCategory = 'inbox' | 'active' | 'review' | 'closed';
export type CompanionCapability = 'listings' | 'agents' | 'agent_profile_write' | 'listing_removal' | 'messages';
export type AgentMapping = { state: 'mapped'; localAgent: string } | { state: 'missing' | 'ambiguous' | 'conflict'; reason: string };
export interface MarketplaceRequest {
  id: string; listing_id: string; agent_id: string | null; requester_wallet: string; title: string; description: string;
  attachment_refs: string[]; listing_snapshot: Record<string, unknown>; status: RequestStatus; provider_summary: string | null;
  kanban_card_id: string | null; assigned_agent: string | null; identity_conflict: boolean; created_at: string; updated_at: string;
  mapping: AgentMapping; category: DeskCategory; card: { id: string; status: string; assignee: string | null } | null;
}
export interface Listing { id: string; agent_id: string; title: string; description: string; price_atomic: string; status: string; updated_at: string | null }
export interface MarketAgent { id: string; name: string; description: string; image_url: string | null; listing_ids: string[] }
export interface MarketMessage { id: string; conversation_id: string; agent_id: string; sender_wallet: string; body: string; created_at: string }
export interface Capabilities { requests: boolean; companion: Record<CompanionCapability, boolean> }
export type RequestAction = 'accept' | 'reject' | 'start' | 'request_changes' | 'complete';
export interface ProfilePatch { name?: string; description?: string; image_url?: string | null }
export type ApiResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string };

export interface CybazaarApi {
  capabilities(): Promise<ApiResult<Capabilities>>;
  requests(): Promise<ApiResult<{ requests: MarketplaceRequest[]; syncError?: string }>>;
  act(id: string, action: RequestAction, summary?: string): Promise<ApiResult<{ status: RequestStatus; marketplaceSync: 'synced' | 'pending' }>>;
  services(): Promise<ApiResult<{ listings: Listing[] }>>;
  agents(): Promise<ApiResult<{ agents: MarketAgent[] }>>;
  updateAgent(agentId: string, patch: ProfilePatch): Promise<ApiResult<{ agent: MarketAgent }>>;
  removeFromListing(agentId: string, listingId: string): Promise<ApiResult<{ listing: Listing }>>;
  messages(): Promise<ApiResult<{ messages: MarketMessage[]; withheld: number }>>;
}

const base = '/api/desk/cybazaar';
export function createHttpCybazaarApi(request: typeof fetch = (...args) => fetch(...args)): CybazaarApi {
  async function call<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    try {
      const response = await request(`${base}${path}`, { credentials: 'same-origin', cache: 'no-store', ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), accept: 'application/json' } });
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (response.ok) return { ok: true, value: body as T };
      const error = (body.error && typeof body.error === 'object' ? body.error : {}) as Record<string, unknown>;
      return { ok: false, status: response.status, code: typeof error.code === 'string' ? error.code : 'failed', message: typeof error.message === 'string' ? error.message : `Cybazaar request failed (${response.status}).` };
    } catch (cause) {
      return { ok: false, status: 0, code: 'network', message: cause instanceof Error ? cause.message : 'Network error.' };
    }
  }
  const send = (method: string, value?: unknown): RequestInit => ({ method, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return {
    capabilities: () => call('/capabilities'),
    requests: () => call('/requests'),
    act: (id, action, summary) => call(`/requests/${encodeURIComponent(id)}/${action}`, send('POST', { ...(summary ? { summary } : {}) })),
    services: () => call('/services'),
    agents: () => call('/agents'),
    updateAgent: (agentId, patch) => call(`/agents/${encodeURIComponent(agentId)}`, send('PATCH', patch)),
    removeFromListing: (agentId, listingId) => call(`/agents/${encodeURIComponent(agentId)}/listings/${encodeURIComponent(listingId)}`, send('DELETE')),
    messages: () => call('/messages'),
  };
}
