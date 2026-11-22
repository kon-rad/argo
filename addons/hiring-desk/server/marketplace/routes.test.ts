import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { CybazaarIntegration } from './cybazaar-integration.js';
import { cybazaarRequestsRouter } from './routes.js';
import { fakeCybazaar, memoryBoard } from './fakes.vitest.js';

const OWNED = '20000000-0000-4000-8000-000000000001', FOREIGN = '20000000-0000-4000-8000-000000000009';
const LISTING = '10000000-0000-4000-8000-000000000001', OTHER_LISTING = '10000000-0000-4000-8000-000000000002';
const WALLET = '0x' + 'b'.repeat(40);
const agentRecord = (overrides: Record<string, unknown> = {}) => ({ id: OWNED, name: 'Akira', description: 'Anime shorts', image_url: null, listing_ids: [LISTING], ...overrides });
const listingRecord = (overrides: Record<string, unknown> = {}) => ({ id: LISTING, agent_id: OWNED, title: 'Anime short', description: 'Fifteen seconds', price_atomic: '5000000', status: 'published', updated_at: '2026-11-20T00:00:00Z', ...overrides });
const ALL = ['listings', 'agents', 'agent_profile_write', 'listing_removal', 'messages'];

function app(options: { capabilities?: string[] | null; owner?: boolean; routes?: Record<string, (body: unknown) => unknown> } = {}) {
  const remote = fakeCybazaar({
    ...(options.capabilities === null ? {} : { 'GET /api/v1/integrations/argo/capabilities': () => ({ capabilities: options.capabilities ?? ALL }) }),
    'GET /api/v1/integrations/argo/agents': () => ({ agents: [agentRecord()] }),
    'GET /api/v1/integrations/argo/listings': () => ({ listings: [listingRecord()] }),
    [`PATCH /api/v1/integrations/argo/agents/${OWNED}`]: (body) => ({ agent: agentRecord(body as Record<string, unknown>) }),
    [`POST /api/v1/integrations/argo/listings/${LISTING}/unlist`]: () => ({ listing: listingRecord({ status: 'unlisted' }) }),
    'GET /api/v1/integrations/argo/messages': () => ({ messages: [
      { id: '30000000-0000-4000-8000-000000000001', conversation_id: '40000000-0000-4000-8000-000000000001', agent_id: OWNED, sender_wallet: WALLET, body: 'Can you make a 15 second loop?', created_at: '2026-11-22T00:00:00Z' },
      { id: '30000000-0000-4000-8000-000000000002', conversation_id: '40000000-0000-4000-8000-000000000002', agent_id: FOREIGN, sender_wallet: WALLET, body: 'Private note for someone else', created_at: '2026-11-22T00:00:00Z' },
    ] }),
    ...options.routes,
  });
  const database = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), transact: vi.fn() };
  const integration = new CybazaarIntegration({ origin: 'https://market.example.com', secret: 'test-secret-'.repeat(4), database: database as never, board: memoryBoard().board, fetcher: remote.fetcher });
  const gate = (_req: Request, res: Response, next: NextFunction) => options.owner === false ? res.status(401).json({ error: 'login required' }) : next();
  const server = express();
  server.use('/api/desk/cybazaar', cybazaarRequestsRouter(integration, gate));
  return { server, remote };
}

describe('Cybazaar owner routes', () => {
  it('denies every route without an owner session and never contacts Cybazaar', async () => {
    const { server, remote } = app({ owner: false });
    for (const [method, path] of [['get', '/capabilities'], ['get', '/requests'], ['get', '/services'], ['get', '/agents'], ['get', '/messages'], ['patch', `/agents/${OWNED}`], ['delete', `/agents/${OWNED}/listings/${LISTING}`], ['post', '/requests/x/accept']] as const) {
      const response = await request(server)[method](`/api/desk/cybazaar${path}`).send({ name: 'Hijack' });
      expect(response.status, `${method} ${path}`).toBe(401);
    }
    expect(remote.calls).toHaveLength(0);
  });

  it('reports companion capabilities and marks everything unavailable on an older Cybazaar', async () => {
    const live = await request(app().server).get('/api/desk/cybazaar/capabilities');
    expect(live.body).toEqual({ requests: true, companion: { listings: true, agents: true, agent_profile_write: true, listing_removal: true, messages: true } });
    const old = app({ capabilities: null });
    const response = await request(old.server).get('/api/desk/cybazaar/capabilities');
    expect(response.body.companion).toEqual({ listings: false, agents: false, agent_profile_write: false, listing_removal: false, messages: false });
    const services = await request(old.server).get('/api/desk/cybazaar/services');
    expect(services.status).toBe(501);
    expect(services.body.error.code).toBe('unsupported');
    expect(old.remote.calls.map(call => call.path)).not.toContain('/api/v1/integrations/argo/listings');
  });

  it('lists scoped services and agents with the server credential only', async () => {
    const { server, remote } = app();
    const services = await request(server).get('/api/desk/cybazaar/services');
    expect(services.body.listings).toEqual([expect.objectContaining({ id: LISTING, agent_id: OWNED, price_atomic: '5000000' })]);
    const agents = await request(server).get('/api/desk/cybazaar/agents');
    expect(agents.body.agents).toEqual([expect.objectContaining({ id: OWNED, name: 'Akira' })]);
    expect(services.headers['cache-control']).toBe('no-store');
    expect(remote.calls.every(call => call.auth === `Bearer ${'test-secret-'.repeat(4)}`)).toBe(true);
    expect(JSON.stringify(services.body) + JSON.stringify(agents.body)).not.toContain('test-secret');
  });

  it('forwards an authorized profile edit for an owned agent and returns the persisted profile', async () => {
    const { server, remote } = app();
    const response = await request(server).patch(`/api/desk/cybazaar/agents/${OWNED}`).send({ name: '  Akira Studio ', description: 'Anime loops', image_url: 'https://images.example.com/akira.png' });
    expect(response.status).toBe(200);
    expect(response.body.agent).toMatchObject({ id: OWNED, name: 'Akira Studio', description: 'Anime loops', image_url: 'https://images.example.com/akira.png' });
    const patch = remote.calls.find(call => call.method === 'PATCH')!;
    expect(patch.path).toBe(`/api/v1/integrations/argo/agents/${OWNED}`);
    expect(patch.body).toMatchObject({ name: 'Akira Studio', description: 'Anime loops', image_url: 'https://images.example.com/akira.png', idempotencyKey: expect.stringMatching(/^argo-profile-/) });
  });

  it('refuses edits to an agent outside the credential scope without forwarding them', async () => {
    const { server, remote } = app();
    const response = await request(server).patch(`/api/desk/cybazaar/agents/${FOREIGN}`).send({ name: 'Hijack' });
    expect(response.status).toBe(404);
    expect(remote.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('rejects unsafe or unknown profile fields', async () => {
    const { server, remote } = app();
    for (const body of [{ image_url: 'javascript:alert(1)' }, { image_url: 'http://images.example.com/a.png' }, { name: '' }, { name: 'x'.repeat(81) }, { owner_wallet: WALLET }, {}]) {
      const response = await request(server).patch(`/api/desk/cybazaar/agents/${OWNED}`).send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(remote.calls.some(call => call.method === 'PATCH')).toBe(false);
  });

  it('removes an owned agent from its own listing only', async () => {
    const { server, remote } = app();
    const removed = await request(server).delete(`/api/desk/cybazaar/agents/${OWNED}/listings/${LISTING}`);
    expect(removed.status).toBe(200);
    expect(removed.body.listing).toMatchObject({ id: LISTING, status: 'unlisted' });
    const unlist = remote.calls.find(call => call.path.endsWith('/unlist'))!;
    expect(unlist.body).toEqual({ agentId: OWNED, idempotencyKey: `argo-unlist-${LISTING}` });
    const foreign = await request(server).delete(`/api/desk/cybazaar/agents/${OWNED}/listings/${OTHER_LISTING}`);
    expect(foreign.status).toBe(404);
    const notOwned = await request(server).delete(`/api/desk/cybazaar/agents/${FOREIGN}/listings/${LISTING}`);
    expect(notOwned.status).toBe(404);
    expect(remote.calls.filter(call => call.path.endsWith('/unlist'))).toHaveLength(1);
  });

  it('shows messages addressed to owned agents and withholds any other conversation', async () => {
    const { server } = app();
    const response = await request(server).get('/api/desk/cybazaar/messages');
    expect(response.status).toBe(200);
    expect(response.body.messages).toHaveLength(1);
    expect(response.body.messages[0]).toMatchObject({ agent_id: OWNED, body: 'Can you make a 15 second loop?' });
    expect(response.body.withheld).toBe(1);
    expect(JSON.stringify(response.body)).not.toContain('Private note for someone else');
  });

  it('fails closed on messages when agent scope is unavailable', async () => {
    const { server, remote } = app({ capabilities: ['messages'] });
    const response = await request(server).get('/api/desk/cybazaar/messages');
    expect(response.status).toBe(501);
    expect(remote.calls.map(call => call.path)).not.toContain('/api/v1/integrations/argo/messages');
  });

  it('turns malformed or hostile remote data into an error instead of rendering it', async () => {
    const { server } = app({ routes: { 'GET /api/v1/integrations/argo/agents': () => ({ agents: [agentRecord({ image_url: 'javascript:alert(1)' })] }) } });
    const response = await request(server).get('/api/desk/cybazaar/agents');
    expect(response.status).toBe(502);
  });

  it('reports a credential Cybazaar refuses as a gateway error, not an owner sign-out', async () => {
    const { server } = app({ routes: { 'GET /api/v1/integrations/argo/agents': () => new Response('{}', { status: 403 }) } });
    const response = await request(server).get('/api/desk/cybazaar/agents');
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe('denied');
  });
});
