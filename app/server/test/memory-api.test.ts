import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { importOrg } from '../src/org.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

/**
 * The /memory page's API (docs/memory.md, engine core v2 phase 6): the facts, the candidates finished sessions
 * proposed, and the retire button. The route mounts from the memory feature's manifest, so these tests exercise the
 * `memory` core module exactly as the browser does.
 */

const app = createApp({ modules: ALL_MODULES });

const ORG = {
  version: 'memory-api-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    rune: { role: 'Engineer', team: 'platform', reports_to: 'owner' },
  },
  teams: { platform: { name: 'Platform', lead: 'rune' } },
  channels: { 'all-hands': { members: '*' } },
};

/** One archived session and its summary, the parent a candidate fact needs. */
async function seedSummary(): Promise<number> {
  const s = await query<{ id: number }>(
    `INSERT INTO archive_sessions (source, host, external_id, started_at, ended_at) VALUES ('claude-code','box','a', now() - interval '2 hours', now() - interval '1 hour') RETURNING id`,
  );
  const r = await query<{ id: number }>(
    `INSERT INTO agent_summaries (session_id, prompt_version, source_sha, status, harness, host, started_at, ended_at, request, done, learned, open_items, outcome, metrics)
     VALUES ($1,'v1','sha','ok','claude-code','box', now() - interval '2 hours', now() - interval '1 hour','Fix it','Fixed it','','','finished','{}') RETURNING id`,
    [s.rows[0]!.id],
  );
  return r.rows[0]!.id;
}

beforeEach(async () => {
  await truncateAll();
  await importOrg(ORG);
});

describe('memory api', () => {
  it('writes a fact, lists it, filters by agent, and retires it', async () => {
    const empty = await request(app).get('/api/memory').expect(200);
    expect(empty.body.facts).toEqual([]);

    const a = await request(app).post('/api/memory').send({ subject: 'deploy window', claim: 'the timer never notices an env change', source: 'docs/deployment.md' }).expect(200);
    expect(a.body).toMatchObject({ subject: 'deploy window', agent: null, confidence: 'confirmed', author: 'owner' });
    const b = await request(app).post('/api/memory').send({ subject: 'scratch notes', claim: 'I keep scratch under the cache dir', source: 'docs/memory.md', agent: 'rune' }).expect(200);
    expect(b.body.agent).toBe('rune');

    expect((await request(app).get('/api/memory').expect(200)).body.facts).toHaveLength(2);
    expect((await request(app).get('/api/memory').query({ agent: 'rune' })).body.facts.map((f: { id: number }) => f.id)).toEqual([b.body.id]);

    // A bad body is a 400, a bad agent is refused before the write.
    await request(app).post('/api/memory').send({ subject: 'x', claim: 'y' }).expect(400);
    expect((await request(app).post('/api/memory').send({ subject: 'x', claim: 'y', source: 'z', agent: 'ghost' })).status).toBe(400);

    expect((await request(app).post(`/api/memory/${a.body.id}/retire`).send({})).status).toBe(400);
    await request(app).post(`/api/memory/${a.body.id}/retire`).send({ why: 'measured again' }).expect(200);
    expect((await request(app).get('/api/memory')).body.facts.map((f: { id: number }) => f.id)).toEqual([b.body.id]);
    expect((await request(app).get('/api/memory').query({ all: true })).body.facts).toHaveLength(2);
    expect((await request(app).post('/api/memory/99999/retire').send({ why: 'x' })).status).toBe(404);
  });

  it('holds candidates until they are approved, then writes the fact with the session\'s agent', async () => {
    const summary = await seedSummary();
    const c = await query<{ id: number }>(`INSERT INTO agent_summary_facts (summary_id, subject, claim, agent) VALUES ($1,'billing','Codes are deduplicated.','rune') RETURNING id`, [summary]);
    const id = c.rows[0]!.id;

    expect((await request(app).get('/api/memory/candidates').expect(200)).body.candidates.map((x: { id: number }) => x.id)).toEqual([id]);
    expect((await query(`SELECT 1 FROM memory_facts`)).rowCount).toBe(0);

    const ok = await request(app).post(`/api/memory/candidates/${id}/promote`).send({ claim: 'Codes are deduplicated before they apply.' }).expect(200);
    expect(ok.body).toMatchObject({ id, status: 'promoted' });
    const fact = (await query(`SELECT subject, claim, source, author, agent, confidence FROM memory_facts WHERE id = $1`, [ok.body.fact_id])).rows[0];
    expect(fact).toMatchObject({ subject: 'billing', claim: 'Codes are deduplicated before they apply.', author: 'summarizer', agent: 'rune', confidence: 'inferred' });
    expect(fact.source).toMatch(/^agent-summary:\d+ \(session box\/a\)$/);

    // A second decision is a 409; the queue is empty now.
    expect((await request(app).post(`/api/memory/candidates/${id}/promote`).send({})).status).toBe(409);
    expect((await request(app).get('/api/memory/candidates')).body.candidates).toEqual([]);
    expect((await request(app).get('/api/memory/candidates').query({ status: 'promoted' })).body.candidates).toHaveLength(1);
  });

  it('rejects a candidate and 404s one that never existed', async () => {
    const summary = await seedSummary();
    const c = await query<{ id: number }>(`INSERT INTO agent_summary_facts (summary_id, subject, claim) VALUES ($1,'x','y') RETURNING id`, [summary]);
    expect((await request(app).post(`/api/memory/candidates/${c.rows[0]!.id}/reject`).expect(200)).body.status).toBe('rejected');
    expect((await request(app).post(`/api/memory/candidates/${c.rows[0]!.id}/reject`)).status).toBe(409);
    expect((await request(app).post('/api/memory/candidates/999/promote').send({})).status).toBe(404);
    expect((await query(`SELECT 1 FROM memory_facts`)).rowCount).toBe(0);
  });
});
