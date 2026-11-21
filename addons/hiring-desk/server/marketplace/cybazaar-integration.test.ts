import { describe, expect, it, vi } from 'vitest';
import { CybazaarIntegration } from './cybazaar-integration.js';

type Database = ConstructorParameters<typeof CybazaarIntegration>[0]['database'];
type Event = { id: number; request_id: string; status: string; summary: string | null; idempotency_key: string; delivered?: boolean };
const id = '00000000-0000-4000-8000-000000000001';

function fixture() {
  let status = 'submitted', available = true, loseResponse = false;
  const outbox: Event[] = [], delivered = new Map<string, string>(), attempts: string[] = [];
  let lock = Promise.resolve();
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.startsWith('SELECT request_id AS id')) return { rows: [{ id, status, kanban_card_id: 't_fixture', listing_snapshot: { listingName: 'Fixture', agentName: 'Provider' }, attachment_refs: [] }] };
    if (sql.startsWith('SELECT local_status')) return { rows: [{ local_status: status }] };
    if (sql.startsWith('UPDATE desk_cybazaar_requests')) status = String(params[1]);
    if (sql.startsWith('INSERT INTO desk_cybazaar_outbox')) {
      if (!outbox.some(e => e.idempotency_key === params[3])) outbox.push({ id: outbox.length + 1, request_id: id, status: String(params[1]), summary: params[2] as string | null, idempotency_key: String(params[3]) });
    }
    if (sql.startsWith('SELECT id,request_id')) return { rows: outbox.filter(e => !e.delivered) };
    if (sql.startsWith('UPDATE desk_cybazaar_outbox SET delivered_at')) outbox.find(e => e.id === params[0])!.delivered = true;
    if (sql.startsWith('SELECT count(*)')) return { rows: [{ count: outbox.filter(e => !e.delivered).length }] };
    return { rows: [], rowCount: 1 };
  });
  const database = { query, async transact(fn: (q: Database['query']) => Promise<unknown>) {
    const previous = lock;
    let release!: () => void;
    lock = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await fn(query as unknown as Database['query']); } finally { release(); }
  } } as Database;
  const board = { get: vi.fn(), create: vi.fn(async (input) => ({ ...input, status: 'triage' })), assign: vi.fn(), move: vi.fn() };
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const event = JSON.parse(String(init?.body));
    attempts.push(event.idempotencyKey);
    if (!available) throw new Error('offline');
    delivered.set(event.idempotencyKey, event.status);
    if (loseResponse) throw new Error('Response lost after remote commit');
    return Response.json({});
  }) as unknown as typeof fetch;
  const service = () => new CybazaarIntegration({ origin: 'https://market.example.com', secret: 'test-secret-'.repeat(4), database, board, fetcher });
  return { service, outbox, delivered, attempts, offline: () => { available = false; }, online: () => { available = true; }, loseResponse: (value: boolean) => { loseResponse = value; } };
}

describe('Cybazaar transition outbox', () => {
  it('delivers both in_progress transitions in a revision cycle exactly once', async () => {
    const f = fixture(), service = f.service();
    const cycle = ['accepted', 'in_progress', 'revision_requested', 'in_progress'] as const;
    for (const status of cycle) expect(await service.transition(id, status)).toBe(true);
    expect(f.outbox.map(e => e.status)).toEqual(cycle);
    expect([...f.delivered.values()]).toEqual(cycle);
    expect(new Set(f.outbox.map(e => e.idempotency_key)).size).toBe(4);
    await service.transition(id, 'in_progress');
    await service.flushOutbox();
    expect(f.attempts).toHaveLength(4);
  });

  it('reuses the persisted key after failure and a connector restart', async () => {
    const f = fixture();
    f.offline();
    expect(await f.service().transition(id, 'accepted')).toBe(false);
    const key = f.outbox[0]!.idempotency_key;
    f.online();
    expect(await f.service().transition(id, 'accepted')).toBe(true);
    expect(f.attempts).toEqual([key, key]);
    expect(f.outbox).toHaveLength(1);
    expect(f.delivered.size).toBe(1);
  });

  it('retries a lost acknowledgement without applying a second remote event', async () => {
    const f = fixture();
    f.loseResponse(true);
    expect(await f.service().transition(id, 'accepted')).toBe(false);
    expect(f.delivered.size).toBe(1);
    f.loseResponse(false);
    expect(await f.service().transition(id, 'accepted')).toBe(true);
    expect(f.attempts).toEqual([f.outbox[0]!.idempotency_key, f.outbox[0]!.idempotency_key]);
    expect(f.outbox).toHaveLength(1);
    expect(f.delivered.size).toBe(1);
  });

  it('treats competing identical transitions as one event under the row lock', async () => {
    const f = fixture(), service = f.service();
    await expect(Promise.all([service.transition(id, 'accepted'), service.transition(id, 'accepted')])).resolves.toEqual([true, true]);
    expect(f.outbox).toHaveLength(1);
    expect(f.delivered.size).toBe(1);
  });
});
