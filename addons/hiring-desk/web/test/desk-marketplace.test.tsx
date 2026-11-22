import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DeskOperatorApi, OperatorJob } from '@secondbrain/desk-contracts/desk';
import Desk from '../src/Desk.js';
import type { Capabilities, CybazaarApi, Listing, MarketAgent, MarketMessage, MarketplaceRequest } from '../src/cybazaarApi.js';

afterEach(() => cleanup());

const AGENT = '20000000-0000-4000-8000-000000000001', LISTING = '10000000-0000-4000-8000-000000000001';
const allOn: Capabilities = { requests: true, companion: { listings: true, agents: true, agent_profile_write: true, listing_removal: true, messages: true } };
const allOff: Capabilities = { requests: true, companion: { listings: false, agents: false, agent_profile_write: false, listing_removal: false, messages: false } };
const request = (overrides: Partial<MarketplaceRequest> = {}): MarketplaceRequest => ({
  id: '00000000-0000-4000-8000-000000000001', listing_id: LISTING, agent_id: AGENT, requester_wallet: '0x' + 'a'.repeat(40),
  title: 'Anime loop', description: '<script>window.pwned=1</script> Please animate this.', attachment_refs: [],
  listing_snapshot: { listingName: 'Anime short', agentName: 'Totally Akira', priceAtomic: '5000000' }, status: 'submitted', provider_summary: null,
  kanban_card_id: null, assigned_agent: null, identity_conflict: false, created_at: '2026-11-22T00:00:00Z', updated_at: '2026-11-22T00:00:00Z',
  mapping: { state: 'mapped', localAgent: 'akira' }, category: 'inbox', card: null, ...overrides,
});
const agent: MarketAgent = { id: AGENT, name: 'Akira', description: 'Anime shorts', image_url: null, listing_ids: [LISTING] };
const listing: Listing = { id: LISTING, agent_id: AGENT, title: 'Anime short', description: 'Fifteen seconds', price_atomic: '5000000', status: 'published', updated_at: null };
const message: MarketMessage = { id: '30000000-0000-4000-8000-000000000001', conversation_id: '40000000-0000-4000-8000-000000000001', agent_id: AGENT, sender_wallet: '0x' + 'b'.repeat(40), body: 'Can you make it loop?', created_at: '2026-11-22T01:00:00Z' };

const ok = <T,>(value: T) => ({ ok: true as const, value });
function market(options: { capabilities?: Capabilities; requests?: MarketplaceRequest[] } = {}) {
  let requests = options.requests ?? [request()];
  const api: CybazaarApi = {
    capabilities: vi.fn(async () => ok(options.capabilities ?? allOn)),
    requests: vi.fn(async () => ok({ requests })),
    act: vi.fn(async () => ok({ status: 'accepted' as const, marketplaceSync: 'synced' as const })),
    services: vi.fn(async () => ok({ listings: [listing] })),
    agents: vi.fn(async () => ok({ agents: [agent] })),
    updateAgent: vi.fn(async (_id, patch) => ok({ agent: { ...agent, ...patch } as MarketAgent })),
    removeFromListing: vi.fn(async () => ok({ listing: { ...listing, status: 'unlisted' } })),
    messages: vi.fn(async () => ok({ messages: [message], withheld: 0 })),
  };
  return { api, setRequests: (next: MarketplaceRequest[]) => { requests = next; } };
}
const job = { id: 'job-1', revision: 1, execution: 'running', publicState: { stage: 'accepted', jobRef: 'arkiv:test/job-1', conflict: false, rejected: [], job: { skill: 'research', brief: 'Brief', client: 'wallet:client' } } } as unknown as OperatorJob;
function desk(jobs: OperatorJob[] = []): DeskOperatorApi {
  return { mode: 'fixture', inbox: vi.fn(async () => ({ kind: 'ok' as const, value: jobs.filter(j => j.execution === 'awaiting_operator') })), jobs: vi.fn(async () => ({ kind: 'ok' as const, value: jobs })), job: vi.fn(async () => ({ kind: 'ok' as const, value: jobs[0]! })), providers: vi.fn(async () => ({ kind: 'ok' as const, value: [] })),
    approve: vi.fn(), decline: vi.fn(), cancel: vi.fn(), preview: vi.fn(), release: vi.fn() } as unknown as DeskOperatorApi;
}
const tab = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('Hiring Desk views over Cybazaar', () => {
  it('has the six views and no separate Marketplace tab', async () => {
    render(<Desk operatorApi={desk()} cybazaarApi={market().api} />);
    const nav = screen.getByRole('navigation', { name: 'Desk sections' });
    expect(within(nav).getAllByRole('button').map(b => b.textContent)).toEqual(['Overview', 'Inbox', 'Active', 'Review', 'Services', 'Agents']);
  });

  it('aggregates real activity across requests, messages, jobs, services and agents on the overview', async () => {
    const reviewRequest = request({ id: '00000000-0000-4000-8000-000000000002', title: 'Done loop', status: 'in_progress', category: 'review', kanban_card_id: 't_abc', card: { id: 't_abc', status: 'review', assignee: 'akira' }, assigned_agent: 'akira' });
    render(<Desk operatorApi={desk([job])} cybazaarApi={market({ requests: [request(), reviewRequest] }).api} />);
    expect(await screen.findByRole('button', { name: 'Inbox: 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Active: 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review: 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Services: 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Agents: 1' })).toBeTruthy();
    expect(screen.getByText(/Message to Akira/)).toBeTruthy();
    expect(screen.getByText(/Request “Anime loop”/)).toBeTruthy();
    expect(screen.getByText(/Desk job research · Running/)).toBeTruthy();
  });

  it('shows loading first and a per-source error without hiding the other sources', async () => {
    const { api } = market();
    let release!: () => void;
    vi.mocked(api.requests).mockImplementation(() => new Promise(resolve => { release = () => resolve({ ok: false, status: 502, code: 'failed', message: 'Cybazaar API rejected the request.' }); }));
    render(<Desk operatorApi={desk()} cybazaarApi={api} />);
    tab('Inbox');
    expect(await screen.findByText('Loading…')).toBeTruthy();
    await waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    expect((await screen.findByRole('alert')).textContent).toContain('Cybazaar requests unavailable: Cybazaar API rejected the request.');
    expect(screen.getByText('Message to Akira')).toBeTruthy();
  });

  it('shows an empty state when nothing is waiting', async () => {
    const { api } = market({ requests: [] });
    vi.mocked(api.messages).mockResolvedValue(ok({ messages: [], withheld: 0 }));
    render(<Desk operatorApi={desk()} cybazaarApi={api} />);
    tab('Inbox');
    expect(await screen.findByText(/Nothing waiting/)).toBeTruthy();
    tab('Review');
    expect(await screen.findByText('Nothing is waiting for review.')).toBeTruthy();
  });

  it('accepts a mapped request into one ticket and shows the assignee, treating the brief as text', async () => {
    const m = market();
    const view = render(<Desk operatorApi={desk()} cybazaarApi={m.api} />);
    tab('Inbox');
    fireEvent.click(await screen.findByRole('button', { name: /Anime loop/ }));
    expect(screen.getByText(/Accepting assigns the ticket to akira/)).toBeTruthy();
    expect(screen.getByText(/display name, not used for assignment/)).toBeTruthy();
    expect(view.container.querySelector('script')).toBeNull();
    m.setRequests([request({ status: 'accepted', category: 'active', kanban_card_id: 't_0123456789abcdef01234567', assigned_agent: 'akira', card: { id: 't_0123456789abcdef01234567', status: 'triage', assignee: 'akira' } })]);
    fireEvent.click(screen.getByRole('button', { name: 'Accept and create ticket' }));
    await waitFor(() => expect(m.api.act).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', 'accept', undefined));
    expect(m.api.act).toHaveBeenCalledTimes(1);
    tab('Active');
    fireEvent.click(await screen.findByRole('button', { name: /Anime loop/ }));
    const link = screen.getByRole('link', { name: /Open ticket t_0123456789abcdef01234567/ });
    expect(link.getAttribute('href')).toBe('/board/t_0123456789abcdef01234567');
    expect(screen.getByText(/triage · akira/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start work' })).toBeTruthy();
  });

  it('makes a missing or ambiguous mapping visible and blocks acceptance', async () => {
    const { api } = market({ requests: [request({ mapping: { state: 'ambiguous', reason: 'Listing maps to more than one local agent (akira, echo).' } })] });
    render(<Desk operatorApi={desk()} cybazaarApi={api} />);
    expect(await screen.findByText(/“Anime loop”: agent mapping ambiguous/)).toBeTruthy();
    tab('Inbox');
    fireEvent.click(await screen.findByRole('button', { name: /Anime loop/ }));
    expect(screen.getByText(/more than one local agent \(akira, echo\)/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Accept and create ticket' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows a private message addressed to an owned agent as untrusted text', async () => {
    render(<Desk operatorApi={desk()} cybazaarApi={market().api} />);
    tab('Inbox');
    fireEvent.click(await screen.findByRole('button', { name: /Message to Akira/ }));
    const detail = screen.getByRole('article', { name: 'Marketplace message' });
    expect(within(detail).getByText('Can you make it loop?')).toBeTruthy();
    expect(within(detail).getByText(/never copied to a board card/)).toBeTruthy();
  });

  it('lists real service listings and removes an agent from one only after confirmation', async () => {
    const { api } = market();
    render(<Desk operatorApi={desk()} cybazaarApi={api} />);
    tab('Services');
    expect(await screen.findByText('Anime short')).toBeTruthy();
    expect(screen.getByText(/Akira · 5000000 atomic USDC · published/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from listing' }));
    expect(api.removeFromListing).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Confirm: remove Akira/ }));
    await waitFor(() => expect(api.removeFromListing).toHaveBeenCalledWith(AGENT, LISTING));
  });

  it('edits only the changed profile fields and reports a denied edit', async () => {
    const { api } = market();
    render(<Desk operatorApi={desk()} cybazaarApi={api} />);
    tab('Agents');
    const name = await screen.findByLabelText('Public name');
    fireEvent.change(name, { target: { value: 'Akira Studio' } });
    fireEvent.change(screen.getByLabelText('Avatar image URL (HTTPS)'), { target: { value: 'https://images.example.com/a.png' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(api.updateAgent).toHaveBeenCalledWith(AGENT, { name: 'Akira Studio', image_url: 'https://images.example.com/a.png' }));
    expect(await screen.findByText('Saved to Cybazaar.')).toBeTruthy();
    vi.mocked(api.updateAgent).mockResolvedValueOnce({ ok: false, status: 401, code: 'failed', message: 'login required' });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'New description' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Not authorized: login required');
  });

  it('shows explicit unavailable states when Cybazaar lacks the companion operations', async () => {
    const { api } = market({ capabilities: allOff });
    render(<Desk operatorApi={desk()} cybazaarApi={api} />);
    tab('Services');
    expect(await screen.findByText(/Service listings: not available\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove from listing' })).toBeNull();
    tab('Agents');
    expect(await screen.findByText(/Cybazaar agents: not available\./)).toBeTruthy();
    tab('Inbox');
    expect(await screen.findByText(/Messages: not available\./)).toBeTruthy();
    expect(api.services).not.toHaveBeenCalled();
    expect(api.messages).not.toHaveBeenCalled();
    // Requests still work on an older Cybazaar.
    expect(screen.getByRole('button', { name: /Anime loop/ })).toBeTruthy();
  });

  it('says Cybazaar is not connected when its routes are not mounted', async () => {
    const api = new Proxy({}, { get: () => async () => ({ ok: false, status: 503, code: 'unavailable', message: 'x' }) }) as CybazaarApi;
    render(<Desk operatorApi={desk()} cybazaarApi={api} />);
    expect((await screen.findAllByText(/Cybazaar is not connected to this Desk/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
