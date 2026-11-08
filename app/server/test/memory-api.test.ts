import { readFileSync } from 'node:fs';
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

  it('saves session facts automatically with provenance and agent scope', async () => {
    const summary = await seedSummary();
    const c = (await query(`INSERT INTO agent_summary_facts (summary_id, subject, claim, agent) VALUES ($1,'billing','Codes are deduplicated.','rune') RETURNING *`, [summary])).rows[0];
    expect(c.status).toBe('promoted');
    expect(c.decided_by).toBe('automatic');
    const fact = (await query(`SELECT * FROM memory_facts WHERE id=$1`, [c.fact_id])).rows[0];
    expect(fact).toMatchObject({subject:'billing', claim:'Codes are deduplicated.', author:'summarizer', agent:'rune', confidence:'inferred'});
    expect(fact.source).toMatch(/^agent-summary:\d+ \(session box\/a\)$/);
    expect((await request(app).get('/api/memory/candidates')).body.candidates).toEqual([]);
    expect((await request(app).get('/api/memory')).body.facts).toHaveLength(1);
    await request(app).post(`/api/memory/${c.fact_id}/retire`).send({why:'outdated'}).expect(200);
    expect((await request(app).get('/api/memory')).body.facts).toEqual([]);
    // A repeat of the same scoped claim links to its history, never revives it.
    const again = (await query(`INSERT INTO agent_summary_facts (summary_id, subject, claim, agent) VALUES ($1,'billing','Codes are deduplicated.','rune') RETURNING *`, [summary])).rows[0];
    expect(again.fact_id).toBe(c.fact_id);
    expect((await request(app).get('/api/memory')).body.facts).toEqual([]);
  });

  it('does not reuse another agent memory or save rejected history', async () => {
    const summary = await seedSummary();
    await query(`INSERT INTO agent_summary_facts (summary_id,subject,claim,agent) VALUES ($1,'one','same','rune'),($1,'two','same',NULL)`, [summary]);
    await query(`INSERT INTO agent_summary_facts (summary_id,subject,claim,status) VALUES ($1,'rejected','discarded','rejected')`, [summary]);
    expect((await query(`SELECT * FROM memory_facts`)).rowCount).toBe(2);
    // Legacy decision endpoints are gone: memory is automatic.
    await request(app).post('/api/memory/candidates/1/promote').send({}).expect(410);
    await request(app).post('/api/memory/candidates/1/reject').send({}).expect(410);
    await request(app).post('/api/summaries/facts/1/promote').send({}).expect(410);
  });
  it('migrates pending history once, leaving rejected history untouched', async () => {
    const sql = readFileSync(new URL('../../db/migrations/1756000017400_automatic-memory.sql', import.meta.url), 'utf8');
    const [up, down] = sql.split('-- Down Migration');
    await query(down!);
    try {
      const summary = await seedSummary();
      await query(`INSERT INTO agent_summary_facts (summary_id,subject,claim,status,agent) VALUES
        ($1,'pending','keep me','proposed','rune'),
        ($1,'duplicate','keep me','proposed','rune'),
        ($1,'rejected','discard me','rejected',NULL),
        ($1,'old rejection','discard me','proposed',NULL)`, [summary]);
      await query(up!);
      expect((await query(`SELECT * FROM memory_facts`)).rows).toMatchObject([{claim:'keep me', agent:'rune'}]);
      expect((await query(`SELECT status FROM agent_summary_facts ORDER BY id`)).rows.map(r=>r.status)).toEqual(['promoted','promoted','rejected','rejected']);
      await query(`UPDATE agent_summary_facts SET status=status WHERE status='proposed'`);
      expect((await query(`SELECT 1 FROM memory_facts`)).rowCount).toBe(1);
    } finally {
      // Keep the trigger installed even when an assertion fails.
      await query(down!);
      await query(up!);
    }
  });

  it('deduplicates concurrent sessions within a project and keeps projects separate', async () => {
    await query(`INSERT INTO projects (slug,title,stage) VALUES ('alpha','Alpha','building'),('beta','Beta','building')`);
    const summary = await seedSummary();
    await query(`UPDATE agent_summaries SET project='alpha' WHERE id=$1`, [summary]);
    await Promise.all(Array.from({length:3}, () => query(`INSERT INTO agent_summary_facts (summary_id,subject,claim) VALUES ($1,'lesson','Concurrent claim')`, [summary])));
    expect((await query(`SELECT * FROM memory_facts`)).rows).toMatchObject([{project_slug:'alpha'}]);
    await query(`UPDATE agent_summaries SET project='beta' WHERE id=$1`, [summary]);
    await query(`INSERT INTO agent_summary_facts (summary_id,subject,claim) VALUES ($1,'lesson','Concurrent claim')`, [summary]);
    expect((await query(`SELECT project_slug FROM memory_facts ORDER BY id`)).rows).toEqual([{project_slug:'alpha'},{project_slug:'beta'}]);
  });

});
