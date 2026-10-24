import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query, withTransaction } from '../src/db.js';
import { importOrg } from '../src/org.js';
import * as store from '../src/usage/store.js';
import type { UsageCall } from '../src/usage/types.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

const app = createApp({ modules: ALL_MODULES });
const call = (id: string, ts: string, over: Partial<UsageCall> = {}): UsageCall => ({
  source: 'claude-code', host: 'mac', callId: id, requestId: null, sessionExternalId: 's1', messageExternalId: `u-${id}`,
  ts: new Date(ts), model: 'claude-opus-5-5', entrypoint: 'cli', cwd: '/vault', isSidechain: false,
  inputTokens: 10, cacheWriteTokens: 100, cacheReadTokens: 1000, outputTokens: 50, thinkingTokens: 0, webSearchRequests: 0, ...over,
});

beforeEach(async () => {
  await truncateAll();
  await withTransaction(async (tx) => {
    // 2026-10-13 23:30 UTC is 2026-10-14 08:30 in Tokyo.
    await store.upsertCalls(tx, [call('m1', '2026-10-13T23:30:00Z'), call('m2', '2026-10-14T01:00:00Z'),
      call('m3', '2026-10-14T02:00:00Z', { host: 'droplet', sessionExternalId: 'cc1', entrypoint: 'sdk-cli' })]);
    await store.upsertRuns(tx, [{ host: 'droplet', runId: 't_9-20261014-020000', sessionId: 'cc1', taskId: 't_9', board: 'exo', lane: 'cc-coder',
      agentName: null, teamSlug: null, workType: null, reasons: [], wakeupIds: [], resumed: null,
      model: 'claude-opus-5-5', startedAt: new Date('2026-10-14T02:00:00Z'), endedAt: new Date('2026-10-14T02:05:00Z'),
      durationMs: 300000, durationApiMs: null, numTurns: 9, subtype: 'success', isError: false, totalCostUsd: 0.5,
      usage: null, modelUsage: null, verify: { name: 'argo-exo-tests', passed: true, exitCode: 0, metric: 905, output: '905 passed', at: null },
      logPath: '/home/agent/cc-runs/t_9.jsonl' }]);
    await store.attachCallsToRuns(tx, 'droplet');
  });
});

const day = (tz: string) => request(app).get('/api/usage/series')
  .query({ from: '2026-10-13T00:00:00Z', to: '2026-10-15T00:00:00Z', bucket: 'day', tz, group: 'surface' });

describe('usage api', () => {
  it('buckets days in the viewer\'s time zone and splits by surface', async () => {
    const utc = await day('UTC');
    expect(utc.status).toBe(200);
    expect(utc.body.rows.map((r: { bucket: string; key: string; calls: number }) => [r.bucket.slice(0, 10), r.key, r.calls])).toEqual([
      ['2026-10-13', 'mac', 1], ['2026-10-14', 'cc-lane', 1], ['2026-10-14', 'mac', 1]]);
    // Tokyo's 2026-10-14 starts at 2026-10-13T15:00Z and holds all three calls.
    const tokyo = await day('Asia/Tokyo');
    expect(tokyo.body.rows.map((r: { bucket: string; key: string; calls: number }) => [r.bucket, r.key, r.calls])).toEqual([
      ['2026-10-13T15:00:00.000Z', 'cc-lane', 1], ['2026-10-13T15:00:00.000Z', 'mac', 2]]);
  });

  it('answers 400 for a bad time zone, bucket or an hourly range over 31 days', async () => {
    expect((await day('Mars/Base')).status).toBe(400);
    expect((await request(app).get('/api/usage/series').query({ from: '2026-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z', bucket: 'hour', tz: 'UTC' })).status).toBe(400);
    expect((await request(app).get('/api/usage/series').query({ from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z', bucket: 'week', tz: 'UTC' })).status).toBe(400);
  });

  it('reports the plan as reset when the last reading\'s window has passed, and null with no reading', async () => {
    let r = await request(app).get('/api/usage/plan');
    expect(r.body.current).toEqual({ five_hour: null, seven_day: null });
    await query(`INSERT INTO plan_usage_snapshots (host, origin, "window", used_pct, resets_at, observed_at) VALUES
      ('mac','statusline','five_hour',92, now() - interval '1 minute', now() - interval '2 hours'),
      ('mac','statusline','seven_day',41.2, now() + interval '3 days', now() - interval '1 hour')`);
    r = await request(app).get('/api/usage/plan');
    expect(r.body.current.five_hour).toMatchObject({ used_pct: null, left_pct: null, reset_since_reading: true, last_pct: 92 });
    expect(r.body.current.seven_day).toMatchObject({ used_pct: 41.2, left_pct: 58.8, reset_since_reading: false });
  });

  it('lists sessions with their task and lane, and runs with their verify outcome', async () => {
    const s = await request(app).get('/api/usage/sessions').query({ from: '2026-10-13T00:00:00Z', to: '2026-10-15T00:00:00Z' });
    const cc = s.body.sessions.find((x: { external_id: string }) => x.external_id === 'cc1');
    expect(cc).toMatchObject({ task_id: 't_9', lane: 'cc-coder', surface: 'cc-lane', calls: 1, output: 50 });
    const runs = await request(app).get('/api/usage/runs').query({ from: '2026-10-13T00:00:00Z', to: '2026-10-15T00:00:00Z' });
    expect(runs.body.runs[0]).toMatchObject({ run_id: 't_9-20261014-020000', task_id: 't_9', work_type: 'coding', surface: 'cc-lane', calls: 1, output: 50,
      verify_name: 'argo-exo-tests', verify_passed: true, verify_metric: 905 });
    expect(runs.body.runs[0]).not.toHaveProperty('total_cost_usd');        // subscription: % and tokens, never dollars
    expect(cc.cost_usd).toBeNull();
  });

  it('shows a session\'s messages with the call on the record that carries it, and truncates huge text', async () => {
    await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ id: number }>(`INSERT INTO archive_sessions (source, host, external_id, title)
        VALUES ('claude-code','mac','s1','Plan the usage board') RETURNING id`);
      await tx.query(`INSERT INTO archive_messages (session_id, seq, external_id, role, kind, ts, content_text, raw, raw_sha) VALUES
        ($1, 1, 'u0', 'user', 'user', '2026-10-13T23:29:00Z', 'Build the usage board', '{}', 'a'),
        ($1, 2, 'u-m1', 'assistant', 'assistant', '2026-10-13T23:30:00Z', $2, '{}', 'b')`, [rows[0]!.id, 'x'.repeat(30000)]);
    });
    const r = await request(app).get('/api/usage/sessions/mac/s1').query({ source: 'claude-code' });
    expect(r.status).toBe(200);
    expect(r.body.session.title).toBe('Plan the usage board');
    expect(r.body.messages[0]).toMatchObject({ role: 'user', text: 'Build the usage board', call: null });
    expect(r.body.messages[1]).toMatchObject({ truncated: true, length: 30000, call: { output: 50, cache_read: 1000 } });
    expect(r.body.messages[1].text).toHaveLength(20000);
    expect((await request(app).get('/api/usage/sessions/mac/missing').query({ source: 'claude-code' })).status).toBe(404);
    expect((await request(app).get('/api/usage/sessions/Not_A_Host/s1')).status).toBe(400);
    expect((await request(app).get('/api/usage/sessions/toaster/s1')).status).toBe(404);
    expect((await request(app).get('/api/usage/sessions/mac/s1').query({ source: 'bogus' })).status).toBe(400);
    expect((await request(app).get('/api/usage/messages/abc')).status).toBe(400);
  });

  it('answers the session detail with the same row shape as the list, and no dollars for Claude Code', async () => {
    const d = await request(app).get('/api/usage/sessions/droplet/cc1').query({ source: 'claude-code' });
    expect(d.status).toBe(200);
    expect(d.body.session).toMatchObject({ source: 'claude-code', host: 'droplet', external_id: 'cc1', surface: 'cc-lane',
      task_id: 't_9', lane: 'cc-coder', calls: 1, output: 50, cost_usd: null });
    expect(Object.keys(d.body.session)).toEqual(expect.arrayContaining(['title', 'started_at', 'ended_at', 'input',
      'cache_write', 'cache_read', 'archive_id']));
    expect(d.body.run).not.toHaveProperty('total_cost_usd');
  });

  const snap = (profile: string, sid: string, at: string, inp: number, cost: number | null) => query(
    `INSERT INTO hermes_usage_snapshots (host, profile, session_id, observed_at, model, input_tokens, output_tokens, api_calls, cost_usd)
     VALUES ('droplet', $1, $2, $3, 'glm', $4::bigint, $4::bigint, $4::int, $5::double precision)`, [profile, sid, at, inp, cost]);

  it('sums Hermes deltas per session and shows tokens and cost on the session detail', async () => {
    await snap('main', 'h1', '2026-09-01T00:00:00Z', 100, 1);     // before `from`: only the later delta counts
    await snap('main', 'h1', '2026-10-14T00:00:00Z', 150, 1.5);
    await snap('other', 'h2', '2026-10-14T01:00:00Z', 20, 0.2);
    await snap('other', 'h2', '2026-10-14T02:00:00Z', 50, null);  // unknown cost mid-session: no cost delta
    const r = await request(app).get('/api/usage/series')
      .query({ from: '2026-10-13T00:00:00Z', to: '2026-10-15T00:00:00Z', bucket: 'day', tz: 'UTC', group: 'surface' });
    const h = r.body.rows.find((x: { key: string }) => x.key === 'hermes');
    expect(h).toMatchObject({ input: 100, output: 100, calls: 100 });   // 50 + 20 + 30
    const d = await request(app).get('/api/usage/sessions/droplet/h1').query({ source: 'hermes' });
    expect(d.status).toBe(200);
    expect(d.body.session).toMatchObject({ source: 'hermes', surface: 'hermes', input: 150, cost_usd: 1.5 });
    const d2 = await request(app).get('/api/usage/sessions/droplet/h2').query({ source: 'hermes' });
    expect(d2.body.session.cost_usd).toBe(0.2);
  });

  it('keeps an unknown Hermes cost unknown: a session whose snapshots all lack a cost shows null, not 0', async () => {
    await snap('main', 'h3', '2026-10-14T00:00:00Z', 10, null);
    await snap('main', 'h3', '2026-10-14T01:00:00Z', 40, null);
    const d = await request(app).get('/api/usage/sessions/droplet/h3').query({ source: 'hermes' });
    expect(d.status).toBe(200);
    expect(d.body.session).toMatchObject({ source: 'hermes', input: 40, cost_usd: null });
    const list = await request(app).get('/api/usage/sessions')
      .query({ from: '2026-10-13T00:00:00Z', to: '2026-10-15T00:00:00Z' });
    const row = list.body.sessions.find((x: { external_id: string }) => x.external_id === 'h3');
    expect(row.cost_usd).toBeNull();
  });

  it('clamps a falling known Hermes cost to a zero delta', async () => {
    await snap('main', 'h4', '2026-10-14T00:00:00Z', 10, 0.5);
    await snap('main', 'h4', '2026-10-14T01:00:00Z', 20, 0.3);   // counter went down: no negative delta
    const d = await request(app).get('/api/usage/sessions/droplet/h4').query({ source: 'hermes' });
    expect(d.body.session.cost_usd).toBe(0.5);
  });

  it('strips cost keys from a Claude Code message raw record, and answers 404 for a missing message', async () => {
    const id = await withTransaction(async (tx) => {
      const s = await tx.query<{ id: number }>(`INSERT INTO archive_sessions (source, host, external_id) VALUES ('claude-code','mac','s9') RETURNING id`);
      const m = await tx.query<{ id: number }>(`INSERT INTO archive_messages (session_id, seq, external_id, role, kind, ts, content_text, raw, raw_sha)
        VALUES ($1, 1, 'x1', 'assistant', 'assistant', now(), 't', $2, 'c') RETURNING id`,
      [s.rows[0]!.id, JSON.stringify({ costUSD: 0.4, keep: 1, nested: { total_cost_usd: 2, arr: [{ Cost: 1, ok: true }] } })]);
      return m.rows[0]!.id;
    });
    const r = await request(app).get(`/api/usage/messages/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.raw).toEqual({ keep: 1, nested: { arr: [{ ok: true }] } });
    expect((await request(app).get('/api/usage/messages/999999')).status).toBe(404);
  });

  it('rejects offset time zones', async () => {
    expect((await day('+09:00')).status).toBe(400);
  });
  /** A bot's wake: two calls in one resumed session, one a cli-org post, one the final reply. */
  async function seedBot(): Promise<void> {
    await importOrg({ version: 'usage-1', company: 'Argo', ceo: 'owner', teams: { platform: { name: 'Platform', lead: 'atlas' } }, channels: {},
      agents: { owner: { runtime: 'human', role: 'CEO', channels: ['*'] }, atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner', work: 'coding' } } });
    await query(`INSERT INTO projects (slug, title, stage) VALUES ('secondbrain-app', 'Second Brain app', 'building')`);
    await query(`INSERT INTO org_agents (name, runtime, role, org_version) VALUES ('atlas', 'claude-code', 'Head', 'v'), ('owner', 'human', 'CEO', 'v') ON CONFLICT DO NOTHING`);
    await query(`INSERT INTO boards (slug, name) VALUES ('exo', 'Exo') ON CONFLICT DO NOTHING`);
    await query(`INSERT INTO cards (id, board_slug, title, project_slug, assignee, created_by, work_type) VALUES ('t_0bada55e', 'exo', 'Fix the parser', 'secondbrain-app', 'atlas', 'owner', 'coding')`);
    await query(`INSERT INTO org_wakeups (agent_name, reason, ref, created_at, claimed_at, claimed_by, done_at) VALUES ('atlas', 'mention', '62', '2026-10-14T02:59:00Z', '2026-10-14T03:00:00Z', 'org-atlas-20261014-030000', '2026-10-14T03:01:00Z')`);
    await withTransaction(async (tx) => {
      await store.upsertCalls(tx, [
        call('b1', '2026-10-14T03:00:10Z', { host: 'droplet', sessionExternalId: 'bot-s', entrypoint: 'sdk-cli', tool: 'Bash', action: 'post', outputTokens: 70 }),
        call('b2', '2026-10-14T03:00:40Z', { host: 'droplet', sessionExternalId: 'bot-s', entrypoint: 'sdk-cli', tool: null, action: 'reply', outputTokens: 30 }),
        call('b3', '2026-10-14T04:00:10Z', { host: 'droplet', sessionExternalId: 'bot-s', entrypoint: 'sdk-cli', tool: 'Bash', action: 'card', outputTokens: 20 }),
      ]);
      await store.upsertRuns(tx, [
        // No work type in this run's header (an older log): the agent's own default from the roster applies.
        { host: 'droplet', runId: 'org-atlas-20261014-030000', sessionId: 'bot-s', taskId: null, board: null, lane: null, agentName: 'atlas', teamSlug: 'platform',
          workType: null, reasons: [{ reason: 'mention', ref: '62' }], wakeupIds: [1], resumed: true, model: 'claude-opus-5-5',
          startedAt: new Date('2026-10-14T03:00:00Z'), endedAt: new Date('2026-10-14T03:01:00Z'), durationMs: 60000, durationApiMs: null, numTurns: 3,
          subtype: 'success', isError: false, totalCostUsd: null, usage: null, modelUsage: null, verify: null, logPath: '/home/agent/cc-runs/org-atlas-20261014-030000.jsonl' },
        { host: 'droplet', runId: 'org-atlas-20261014-040000', sessionId: 'bot-s', taskId: 't_0bada55e', board: 'exo', lane: null, agentName: 'atlas', teamSlug: 'platform',
          workType: 'coding', reasons: [], wakeupIds: [], resumed: true, model: 'claude-opus-5-5',
          startedAt: new Date('2026-10-14T04:00:00Z'), endedAt: new Date('2026-10-14T04:02:00Z'), durationMs: 120000, durationApiMs: null, numTurns: 2,
          subtype: 'success', isError: false, totalCostUsd: null, usage: null, modelUsage: null, verify: null, logPath: '/home/agent/cc-runs/org-atlas-20261014-040000.jsonl' },
      ]);
      await store.attachCallsToRuns(tx, 'droplet');
    });
  }

  it('labels a bot\'s calls by run: agent, reason, action, card, project and work type, and keeps two wakes of one session apart', async () => {
    await seedBot();
    const facts = await query(`SELECT run_id, agent_name, reason, action, task_id, project_slug, work_type, surface, headless FROM usage_facts WHERE sid = 'bot-s' ORDER BY ts`);
    expect(facts.rows).toEqual([
      { run_id: 'org-atlas-20261014-030000', agent_name: 'atlas', reason: 'mention', action: 'post', task_id: null, project_slug: null, work_type: 'coding', surface: 'bot', headless: true },
      { run_id: 'org-atlas-20261014-030000', agent_name: 'atlas', reason: 'mention', action: 'reply', task_id: null, project_slug: null, work_type: 'coding', surface: 'bot', headless: true },
      { run_id: 'org-atlas-20261014-040000', agent_name: 'atlas', reason: null, action: 'card', task_id: 't_0bada55e', project_slug: 'secondbrain-app', work_type: 'coding', surface: 'bot', headless: true },
    ]);
    const range = { from: '2026-10-13T00:00:00Z', to: '2026-10-15T00:00:00Z' };
    // Group by action, filtered to atlas: post 70, reply 30, card 20 output tokens; the Mac's calls are out.
    const r = await request(app).get('/api/usage/series').query({ ...range, bucket: 'day', tz: 'UTC', group: 'action', agent: 'atlas' });
    expect(r.status).toBe(200);
    expect(r.body.rows.map((x: { key: string; output: number }) => [x.key, Number(x.output)])).toEqual([['card', 20], ['post', 70], ['reply', 30]]);
    // Facets: every dimension's values under the current filters, with totals.
    const f = await request(app).get('/api/usage/facets').query({ ...range, host: 'droplet' });
    expect(f.status).toBe(200);
    expect(f.body.total).toEqual({ calls: 4, tokens: 4 * 1110 + 50 + 70 + 30 + 20 });
    expect(f.body.facets.agent).toEqual([{ value: 'atlas', calls: 3, tokens: 3 * 1110 + 120, output: 120 }, { value: 'unlabelled', calls: 1, tokens: 1160, output: 50 }]);
    expect(f.body.facets.reason.map((x: { value: string }) => x.value)).toEqual(['mention', 'unlabelled']);
    expect(f.body.facets.work_type.map((x: { value: string; calls: number }) => [x.value, x.calls])).toEqual([['coding', 4]]);
    // Several values of one dimension are ORed; two dimensions are ANDed.
    const two = await request(app).get('/api/usage/facets').query({ ...range, action: 'post,card', agent: 'atlas' });
    expect(two.body.total.calls).toBe(2);
    // Runs: one row per wake with its labels and token sums, filterable the same way.
    const runs = await request(app).get('/api/usage/runs').query({ ...range, agent: 'atlas' });
    expect(runs.body.runs.map((x: { run_id: string; reason: string | null; task_id: string | null; project_slug: string | null; calls: number; output: number }) =>
      [x.run_id, x.reason, x.task_id, x.project_slug, x.calls, Number(x.output)])).toEqual([
      ['org-atlas-20261014-040000', null, 't_0bada55e', 'secondbrain-app', 1, 20],
      ['org-atlas-20261014-030000', 'mention', null, null, 2, 100]]);
    expect((await request(app).get('/api/usage/runs').query({ ...range, work_type: 'research' })).body.runs).toEqual([]);
    // An action filter keeps the runs that made such a call.
    expect((await request(app).get('/api/usage/runs').query({ ...range, action: 'post' })).body.runs.map((x: { run_id: string }) => x.run_id)).toEqual(['org-atlas-20261014-030000']);
    expect((await request(app).get('/api/usage/runs').query({ ...range, action: 'dm' })).body.runs).toEqual([]);
    // The wakes table carries tokens per bot.
    const wakes = await request(app).get('/api/usage/org-wakes').query(range);
    expect(wakes.body.agents[0]).toMatchObject({ agent_name: 'atlas', wakes: 1, mention: 1, tokens: 3 * 1110 + 120 });
    // An unknown dimension value is simply empty; an unknown group is a 400.
    expect((await request(app).get('/api/usage/series').query({ ...range, bucket: 'day', tz: 'UTC', group: 'colour' })).status).toBe(400);
    expect((await request(app).get('/api/usage/hosts')).body.hosts.map((h: { slug: string }) => h.slug)).toContain('droplet');
  });
});
