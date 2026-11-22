import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CybazaarIntegration } from './cybazaar-integration.js';
import { parseAgentMap } from './agent-map.js';
import { memoryBoard } from './fakes.vitest.js';

type Database = ConstructorParameters<typeof CybazaarIntegration>[0]['database'];

describe.skipIf(!process.env.SB_TEST_DB)('Cybazaar revision cycle on scratch PostgreSQL', () => {
  let pool: Pool;
  let created = false;
  const schema = 'cyba_sync_test_' + randomUUID().replaceAll('-', '');
  beforeAll(async () => {
    const database = process.env.SB_TEST_DB!;
    if (!/^sb_[a-z0-9_]+_test$/.test(database)) throw new Error('An isolated sb_*_test database is required');
    const host = process.env.PGHOST ?? '127.0.0.1';
    if (!['localhost', '127.0.0.1', '::1'].includes(host) && !host.startsWith('/')) throw new Error('A local scratch PostgreSQL server is required');
    pool = new Pool({ host, database, options: `-c search_path=${schema},public` });
    await pool.query(`CREATE SCHEMA ${schema}`);
    created = true;
    for (const file of ['1756000020700_cybazaar_marketplace_sync.sql', '1756000020900_cybazaar_agent_identity.sql'])
      await pool.query(await readFile(new URL(`../../../../app/db/migrations/${file}`, import.meta.url), 'utf8'));
  });
  afterAll(async () => {
    if (!pool) return;
    try { if (created) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await pool.end(); }
  });

  const database = (): Database => ({
    query: (sql, params) => pool.query(sql, params ? [...params] : undefined) as never,
    async transact(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn((sql, params) => client.query(sql, params ? [...params] : undefined) as never);
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
  });

  it('accepts once under concurrent retries, assigns the mapped agent and keeps identity immutable', async () => {
    const id = randomUUID(), listing = randomUUID(), agent = randomUUID(), otherAgent = randomUUID();
    const remote = (agentId: string) => ({ id, listing_id: listing, agent_id: agentId, requester_wallet: '0x' + 'c'.repeat(40), title: 'Loop', description: 'A short loop', attachment_refs: [], listing_snapshot: { listingName: 'Loop', agentName: 'Display Name' }, status: 'submitted', created_at: '2026-11-22T00:00:00Z', updated_at: '2026-11-22T00:00:00Z' });
    let page = remote(agent);
    const { board, cards } = memoryBoard();
    const service = new CybazaarIntegration({ origin: 'https://market.example.com', secret: 'test-secret-'.repeat(4), database: database(), board,
      agentMap: parseAgentMap(JSON.stringify([{ listingId: listing, agentId: agent, localAgent: 'akira' }])),
      fetcher: vi.fn(async (url: URL | string) => String(url).includes('/requests?') || String(url).endsWith('/requests') ? Response.json({ requests: [page], nextCursor: null }) : Response.json({})) as unknown as typeof fetch });
    await service.refresh();
    await Promise.all([service.transition(id, 'accepted'), service.transition(id, 'accepted'), service.transition(id, 'accepted')]);
    expect(cards.size).toBe(1);
    const row = (await pool.query('SELECT local_status,agent_id,assigned_agent,kanban_card_id,identity_conflict FROM desk_cybazaar_requests WHERE request_id=$1', [id])).rows[0];
    expect(row).toMatchObject({ local_status: 'accepted', agent_id: agent, assigned_agent: 'akira', identity_conflict: false });
    expect([...cards.values()][0]).toMatchObject({ id: row.kanban_card_id, assignee: 'akira', status: 'triage' });
    expect((await pool.query('SELECT count(*)::int AS n FROM desk_cybazaar_outbox WHERE request_id=$1', [id])).rows[0].n).toBe(1);

    // A later poll that names another agent is recorded as a conflict; the stored identity does not change.
    page = { ...remote(otherAgent), status: 'accepted' };
    await service.refresh();
    const after = (await pool.query('SELECT agent_id,assigned_agent,identity_conflict FROM desk_cybazaar_requests WHERE request_id=$1', [id])).rows[0];
    expect(after).toEqual({ agent_id: agent, assigned_agent: 'akira', identity_conflict: true });
    const listed = (await service.list()).requests.find(request => request.id === id)!;
    expect(listed.mapping.state).toBe('conflict');
    expect(listed.category).toBe('active');

    // The database refuses identity rewrites even from a buggy caller.
    await expect(pool.query('UPDATE desk_cybazaar_requests SET listing_id=$2 WHERE request_id=$1', [id, randomUUID()])).rejects.toThrow(/immutable/);
    await expect(pool.query('UPDATE desk_cybazaar_requests SET assigned_agent=$2 WHERE request_id=$1', [id, 'echo'])).rejects.toThrow(/immutable/);
    await expect(pool.query('UPDATE desk_cybazaar_requests SET kanban_card_id=$2 WHERE request_id=$1', [id, 't_' + 'f'.repeat(24)])).rejects.toThrow(/immutable/);
  });

  it('persists distinct revision events and retries an uncertain delivery with the same key', async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO desk_cybazaar_requests(request_id,listing_id,title,description,listing_snapshot,requester_wallet,marketplace_status,local_status,marketplace_updated_at)
      VALUES($1,$2,'Fixture','Public brief','{}','fixture-wallet','accepted','accepted',now())`, [id, randomUUID()]);
    const database: Database = {
      query: (sql, params) => pool.query(sql, params ? [...params] : undefined),
      async transact(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn((sql, params) => client.query(sql, params ? [...params] : undefined));
          await client.query('COMMIT');
          return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
    };
    const applied = new Map<string, string>(), attempts: string[] = [];
    let loseResponse = false;
    const service = () => new CybazaarIntegration({ origin: 'https://market.example.com', secret: 'test-secret-'.repeat(4), database,
      board: { get: vi.fn(), create: vi.fn(), assign: vi.fn(), move: vi.fn() },
      fetcher: vi.fn(async (_url, init) => {
        const event = JSON.parse(String(init?.body));
        attempts.push(event.idempotencyKey);
        applied.set(event.idempotencyKey, event.status);
        if (loseResponse) throw new Error('Response lost after remote commit');
        return Response.json({});
      }) as typeof fetch,
    });
    const cycle = ['in_progress', 'revision_requested', 'in_progress'] as const;
    for (const status of cycle) expect(await service().transition(id, status)).toBe(true);
    expect([...applied.values()]).toEqual(cycle);
    loseResponse = true;
    expect(await service().transition(id, 'completed')).toBe(false);
    const savedKey = attempts.at(-1);
    loseResponse = false;
    expect(await service().transition(id, 'completed')).toBe(true);
    expect(attempts.at(-1)).toBe(savedKey);
    expect(applied.size).toBe(4);
    const rows = (await pool.query('SELECT status,idempotency_key,delivered_at FROM desk_cybazaar_outbox WHERE request_id=$1 ORDER BY id', [id])).rows;
    expect(rows.map(row => row.status)).toEqual([...cycle, 'completed']);
    expect(new Set(rows.map(row => row.idempotency_key)).size).toBe(4);
    expect(rows.every(row => row.delivered_at)).toBe(true);
  });
});
