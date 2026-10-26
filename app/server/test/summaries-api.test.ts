import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { buildDigest, groupOf } from '../src/summaries/digest.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

const app = createApp({ modules: ALL_MODULES });

async function seed(ext: string, over: Record<string, unknown> = {}): Promise<{ session: number; summary: number }> {
  const s = await query<{ id: number }>(
    `INSERT INTO archive_sessions (source, host, external_id, started_at, ended_at) VALUES ($1,'droplet',$2, now() - interval '3 hours', now() - interval '2 hours') RETURNING id`,
    [over.source ?? 'claude-code', ext]);
  const m = { input_tokens: 10, cache_write_tokens: 100, cache_read_tokens: 1000, output_tokens: 50, error_steps: 2 };
  const r = await query<{ id: number }>(
    `INSERT INTO agent_summaries (session_id, prompt_version, source_sha, status, harness, host, project, started_at, ended_at, request, done, learned, open_items, outcome, metrics, writer_provider, writer_model, writer_input_tokens, writer_output_tokens)
     VALUES ($1,'v1','sha','ok',$2,'droplet',$3, now() - interval '3 hours', now() - interval '2 hours',$4,$5,$6,$7,$8,$9,'ollama','qwen3.6:35b-a3b',500,100) RETURNING id`,
    [s.rows[0]!.id, over.harness ?? 'claude-code', over.project ?? null, over.request ?? 'Fix the billing bug', over.done ?? 'Fixed it', over.learned ?? '', over.open_items ?? '', over.outcome ?? 'finished', JSON.stringify(m)]);
  return { session: s.rows[0]!.id, summary: r.rows[0]!.id };
}

beforeEach(truncateAll);

describe('summaries api', () => {
  it('lists, filters and searches', async () => {
    await seed('a', { project: 'shop', request: 'Fix the billing bug' });
    await seed('b', { harness: 'hermes', source: 'hermes:builder', outcome: 'blocked', request: 'Deploy the site', open_items: 'needs the SSH key' });
    const all = await request(app).get('/api/summaries');
    expect(all.status).toBe(200);
    expect(all.body.summaries).toHaveLength(2);
    expect((await request(app).get('/api/summaries').query({ outcome: 'blocked' })).body.summaries.map((s: { external_id: string }) => s.external_id)).toEqual(['b']);
    expect((await request(app).get('/api/summaries').query({ harness: 'claude-code', project: 'shop' })).body.summaries).toHaveLength(1);
    expect((await request(app).get('/api/summaries').query({ q: 'ssh key' })).body.summaries).toHaveLength(1);
    expect((await request(app).get('/api/summaries').query({ q: '100%' })).body.summaries).toHaveLength(0); // % is literal, not a wildcard
    expect((await request(app).get('/api/summaries').query({ outcome: 'blocked', provider: 'together' })).body.summaries).toHaveLength(0);
    expect((await request(app).get('/api/summaries').query({ from: 'nope' })).status).toBe(400);
  });

  it('summarizes the period: outcomes, days in the viewer time zone, writers', async () => {
    await seed('a');
    await seed('b', { outcome: 'failed' });
    const r = await request(app).get('/api/summaries/overview').query({ tz: 'Asia/Tokyo' });
    expect(r.status).toBe(200);
    expect(Object.fromEntries(r.body.outcomes.map((o: { key: string; n: number }) => [o.key, o.n]))).toEqual({ finished: 1, failed: 1 });
    expect(r.body.days).toHaveLength(1);
    expect(r.body.days[0]).toMatchObject({ sessions: 2, finished: 1, stuck: 1, errors_per_session: 2 });
    expect(Number(r.body.days[0].tokens)).toBe(2 * 1160);
    expect(r.body.writers).toEqual([{ key: 'ollama/qwen3.6:35b-a3b', n: 2, input: 1000, output: 200 }]);
    expect((await request(app).get('/api/summaries/overview').query({ tz: 'Mars/Base' })).status).toBe(400);
  });

  it('promotes a candidate into memory_facts with its source, once', async () => {
    await query(`INSERT INTO teams (slug, name) VALUES ('t','T') ON CONFLICT DO NOTHING`).catch(() => {});
    const { summary } = await seed('a', { project: 'not-a-project' });
    const f = await query<{ id: number }>(`INSERT INTO agent_summary_facts (summary_id, subject, claim) VALUES ($1,'billing','Discount codes are deduplicated.') RETURNING id`, [summary]);
    const id = f.rows[0]!.id;
    const ok = await request(app).post(`/api/summaries/facts/${id}/promote`).send({ claim: 'Discount codes are deduplicated before they apply.' });
    expect(ok.status).toBe(200);
    const fact = (await query(`SELECT subject, claim, source, author, via, confidence, project_slug FROM memory_facts WHERE id = $1`, [ok.body.fact_id])).rows[0];
    expect(fact).toMatchObject({ subject: 'billing', claim: 'Discount codes are deduplicated before they apply.', author: 'summarizer', via: 'agent-summaries', confidence: 'inferred', project_slug: null });
    expect(fact.source).toMatch(/^agent-summary:\d+ \(session droplet\/a\)$/);
    expect((await request(app).post(`/api/summaries/facts/${id}/promote`).send({})).status).toBe(409);
    expect((await request(app).get('/api/summaries/facts').query({ status: 'promoted' })).body.facts).toHaveLength(1);
    expect((await request(app).get('/api/summaries/facts')).body.facts).toHaveLength(0);
  });

  it('rejects a candidate, and 404s a missing one', async () => {
    const { summary } = await seed('a');
    const f = await query<{ id: number }>(`INSERT INTO agent_summary_facts (summary_id, subject, claim) VALUES ($1,'x','y') RETURNING id`, [summary]);
    expect((await request(app).post(`/api/summaries/facts/${f.rows[0]!.id}/reject`)).body.status).toBe('rejected');
    expect((await request(app).post(`/api/summaries/facts/${f.rows[0]!.id}/reject`)).status).toBe(404);
    expect((await request(app).post('/api/summaries/facts/999/promote').send({})).status).toBe(404);
    expect((await query(`SELECT 1 FROM memory_facts`)).rowCount).toBe(0);
  });

  it('returns one summary with its candidates', async () => {
    const { summary } = await seed('a', { learned: 'Codes stacked.' });
    await query(`INSERT INTO agent_summary_facts (summary_id, subject, claim) VALUES ($1,'x','y')`, [summary]);
    const r = await request(app).get(`/api/summaries/${summary}`);
    expect(r.body.summary).toMatchObject({ id: summary, learned: 'Codes stacked.', external_id: 'a' });
    expect(r.body.facts).toHaveLength(1);
    expect((await request(app).get('/api/summaries/99999')).status).toBe(404);
  });
});

describe('the stand-up digest', () => {
  it('groups by project and pulls out open items and unreviewed facts', async () => {
    const a = await seed('a', { project: 'shop', request: 'Fix the billing bug', done: 'Deduplicated codes in invoice.ts' });
    await seed('b', { outcome: 'blocked', request: 'Deploy the site', done: 'Tried deploy.sh', open_items: 'Needs the SSH key' });
    await query(`INSERT INTO agent_summary_facts (summary_id, subject, claim) VALUES ($1,'billing','Codes are deduplicated.')`, [a.summary]);
    const md = await buildDigest(24);
    expect(md).toMatch(/2 sessions: (1 finished, 1 blocked|1 blocked, 1 finished);/);
    expect(md).toContain('### folder shop (1)');
    expect(md).toMatch(/\d+ input\+output tokens \(\d+k? more from cache\)/);
    expect(md).toContain('### no project (1)');
    expect(md).toContain('[blocked] Deploy the site');
    expect(md).toContain('### Open items');
    expect(md).toContain('Needs the SSH key');
    expect(md).toContain('billing: Codes are deduplicated.');
    const http = await request(app).get('/api/summaries/digest').query({ hours: 24 });
    expect(http.type).toBe('text/markdown');
    expect(http.text).toBe(md);
  });
  it('says so when there is nothing, and stays under the cap', async () => {
    expect(await buildDigest(24)).toContain('No summarized sessions');
    for (let i = 0; i < 40; i++) await seed(`s${i}`, { request: 'x'.repeat(130), done: 'y'.repeat(210) });
    expect((await buildDigest(24, 2000)).length).toBeLessThanOrEqual(2000);
  });
});

describe('digest grouping', () => {
  it('prefers the card project, then names the folder a session ran in', () => {
    expect(groupOf({ card_project: 'argo-app', project: '-Users-me-Documents-vault' })).toBe('argo-app');
    expect(groupOf({ card_project: null, project: '-Users-me-Documents-vault' })).toBe('folder vault');
    expect(groupOf({ card_project: null, project: '/home/agent/work/shop/' })).toBe('folder shop');
    expect(groupOf({ card_project: null, project: null })).toBe('no project');
  });
});

describe('the provider dimension on /usage', () => {
  it('labels Claude Code calls anthropic and lets the page filter on it', async () => {
    await query(`INSERT INTO usage_calls (source, host, call_id, session_external_id, ts, model, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens)
                 VALUES ('claude-code','droplet','c1','s1', now() - interval '1 hour', 'claude-opus-5-5', 10, 100, 1000, 50)`);
    const from = new Date(Date.now() - 86400_000).toISOString();
    const to = new Date(Date.now() + 3600_000).toISOString();
    const g = await request(app).get('/api/usage/series').query({ from, to, bucket: 'hour', tz: 'UTC', group: 'provider' });
    expect(g.status).toBe(200);
    expect(g.body.rows.map((r: { key: string }) => r.key)).toEqual(['anthropic']);
    const none = await request(app).get('/api/usage/series').query({ from, to, bucket: 'day', tz: 'UTC', group: 'model', provider: 'together' });
    expect(none.status, JSON.stringify(none.body)).toBe(200);
    expect(none.body.rows).toEqual([]);
  });
});
