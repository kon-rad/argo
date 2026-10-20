import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { withTransaction } from '../src/db.js';
import { sha256 } from '../src/archive/clean.js';
import * as archive from '../src/archive/store.js';
import type { ParsedMessage, SessionInput } from '../src/archive/types.js';
import * as usage from '../src/usage/store.js';
import type { UsageCall } from '../src/usage/types.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

const app = createApp({ modules: ALL_MODULES });

const sess = (over: Partial<SessionInput>): SessionInput => ({
  source: 'claude-code', host: 'mac', externalId: 's1', parentExternalId: null, project: 'p', title: null, model: null,
  startedAt: null, endedAt: null, messageCount: null, inputTokens: null, outputTokens: null, costUsd: null, meta: {}, b2Path: null, ...over,
});
let seq = 0;
const m = (externalId: string, ts: string, raw: Record<string, unknown>, text = ''): ParsedMessage => ({
  seq: ++seq, externalId, parentExternalId: null, role: String(raw.type ?? raw.role), kind: String(raw.type ?? raw.role),
  ts: new Date(ts), contentText: text, raw, rawSha: sha256(JSON.stringify(raw)), isSidechain: false,
});
const cc = (type: string, content: unknown) => ({ type, message: { content } });
const call = (id: string, sid: string, msg: string, out: number): UsageCall => ({
  source: 'claude-code', host: 'mac', callId: id, requestId: null, sessionExternalId: sid, messageExternalId: msg,
  ts: new Date('2026-10-18T10:00:00Z'), model: 'claude-opus-5-5', entrypoint: 'cli', cwd: null, isSidechain: false,
  inputTokens: 10, cacheWriteTokens: 1, cacheReadTokens: 100, outputTokens: out, thinkingTokens: 5, webSearchRequests: 0,
});

beforeEach(async () => {
  await truncateAll();
  seq = 0;
  await withTransaction(async (tx) => {
    const s1 = await archive.upsertSession(tx, sess({ title: 'Fix the usage page' }));
    await archive.upsertMessages(tx, s1.id, [
      m('u1', '2026-10-18T10:00:00Z', cc('user', 'fix the usage page'), 'fix the usage page'),
      m('a1', '2026-10-18T10:00:01Z', cc('assistant', [{ type: 'thinking', thinking: 'look at the route' }])),
      m('a2', '2026-10-18T10:00:02Z', cc('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status' } }])),
      m('r1', '2026-10-18T10:00:04Z', cc('user', [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'not a repo' }])),
      m('a3', '2026-10-18T10:00:06Z', cc('assistant', [{ type: 'text', text: 'Done.' }])),
      m('x1', '2026-10-18T10:00:07Z', { type: 'attachment' }),
    ]);
    await archive.refreshSessionStats(tx, s1.id);
    const sub = await archive.upsertSession(tx, sess({ externalId: 'agent-a1', parentExternalId: 's1', title: 'Explore' }));
    await archive.upsertMessages(tx, sub.id, [
      { ...m('sa1', '2026-10-18T10:00:03Z', cc('assistant', [{ type: 'text', text: 'sub found it' }]), 'sub found it'), isSidechain: true },
    ]);
    await archive.refreshSessionStats(tx, sub.id);
    await usage.upsertCalls(tx, [call('c1', 's1', 'a2', 50), call('c2', 'agent-a1', 'sa1', 20)]);

    const h = await archive.upsertSession(tx, sess({ source: 'hermes', externalId: 'h1', title: 'Stand-up', model: 'deepseek-v4-flash',
      startedAt: new Date('2026-10-18T09:00:00Z'), endedAt: new Date('2026-10-18T09:05:00Z'), messageCount: 3,
      inputTokens: 1000, outputTokens: 200, costUsd: 0.25,
      meta: { billing_provider: 'openrouter', cache_read_tokens: 300, cache_write_tokens: 0, reasoning_tokens: 40, api_call_count: 2 } }));
    await archive.upsertMessages(tx, h.id, [
      m('msg:1', '2026-10-18T09:00:01Z', { id: 1, session_id: 'h1', role: 'user', content: 'run my stand-up' }),
      m('msg:2', '2026-10-18T09:00:02Z', { id: 2, session_id: 'h1', role: 'assistant', content: 'on it', reasoning: 'plan',
        tool_calls: JSON.stringify([{ id: 'call_a', type: 'function', function: { name: 'terminal', arguments: '{"command":"ls"}' } }]) }),
      m('msg:3', '2026-10-18T09:00:03Z', { id: 3, session_id: 'h1', role: 'tool', content: 'a.md', tool_name: 'terminal', tool_call_id: 'call_a' }),
    ]);
  });
});

const list = (q: Record<string, string> = {}) => request(app).get('/api/usage/agent-sessions')
  .query({ from: '2026-10-18T00:00:00Z', to: '2026-10-19T00:00:00Z', ...q });

describe('agent sessions api', () => {
  it('lists every harness, newest first, with Hermes tokens from its own counters and subagents folded in', async () => {
    const r = await list();
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(2);
    const [c, h] = r.body.sessions;
    expect(c).toMatchObject({ harness: 'claude-code', host: 'mac', external_id: 's1', provider: 'anthropic', profile: null,
      title: 'Fix the usage page', first_prompt: 'fix the usage page', subagents: 1, tool_calls: 1, errors: 1,
      calls: 2, input: 20, output: 70, models: ['claude-opus-5-5'] });
    expect(c).not.toHaveProperty('cost_usd');
    expect(c.steps).toBe(6); // 5 own (the attachment is meta) + 1 subagent
    expect(h).toMatchObject({ harness: 'hermes', profile: 'main', provider: 'openrouter', external_id: 'h1', calls: 2,
      input: 1000, output: 200, cache_read: 300, reasoning: 40, cost_usd: 0.25, tool_calls: 1, models: ['deepseek-v4-flash'] });
  });

  it('lists subagents as their own rows on request', async () => {
    const r = await list({ subagents: '1' });
    expect(r.body.sessions.map((s: { external_id: string }) => s.external_id).sort()).toEqual(['agent-a1', 'h1', 's1']);
  });

  it('filters by harness, tool, errors, text and host', async () => {
    const ids = async (q: Record<string, string>) => (await list(q)).body.sessions.map((s: { external_id: string }) => s.external_id);
    expect(await ids({ harness: 'hermes' })).toEqual(['h1']);
    expect(await ids({ tool: 'Bash' })).toEqual(['s1']);
    expect(await ids({ tool: 'terminal' })).toEqual(['h1']);
    expect(await ids({ errors: '1' })).toEqual(['s1']);
    expect(await ids({ q: 'stand-up' })).toEqual(['h1']);
    expect(await ids({ q: 'sub found' })).toEqual(['s1']); // matched inside the subagent
    expect(await ids({ host: 'droplet' })).toEqual([]);
    expect(await ids({ provider: 'openrouter' })).toEqual(['h1']);
  });

  it('serves facets for the filter bar', async () => {
    const r = await request(app).get('/api/usage/agent-sessions/facets').query({ from: '2026-10-18T00:00:00Z', to: '2026-10-19T00:00:00Z' });
    expect(r.body.facets.harness).toEqual([{ value: 'claude-code', n: 2 }, { value: 'hermes', n: 1 }]);
    expect(r.body.facets.tool.map((t: { value: string }) => t.value).sort()).toEqual(['Bash', 'terminal']);
  });

  it('reads a Claude session as steps, with the subagent interleaved, tokens on the call and no dollars', async () => {
    const r = await request(app).get('/api/usage/agent-sessions/mac/s1').query({ source: 'claude-code' });
    expect(r.status).toBe(200);
    expect(r.body.steps.map((s: { step: string; subagent: string | null }) => [s.step, s.subagent])).toEqual([
      ['prompt', null], ['thinking', null], ['tool_call', null], ['response', 'Explore'], ['tool_result', null], ['response', null]]);
    const tc = r.body.steps[2];
    expect(tc).toMatchObject({ toolName: 'Bash', toolCallId: 't1', call: { model: 'claude-opus-5-5', output: 50 } });
    expect(r.body.steps[4]).toMatchObject({ toolCallId: 't1', isError: true, text: 'not a repo' });
    expect(r.body.session).toMatchObject({ external_id: 's1', subagents: 1, output: 70 });
    expect(JSON.stringify(r.body)).not.toMatch(/cost/i);
    expect(r.body.next).toBeNull();
  });

  it('reads a Hermes session as thinking, response, tool call and its result', async () => {
    const r = await request(app).get('/api/usage/agent-sessions/mac/h1').query({ source: 'hermes' });
    expect(r.body.steps.map((s: { step: string; toolName: string | null; toolCallId: string | null }) => [s.step, s.toolName, s.toolCallId])).toEqual([
      ['prompt', null, null], ['thinking', null, null], ['response', null, null], ['tool_call', 'terminal', 'call_a'], ['tool_result', 'terminal', 'call_a']]);
    expect(r.body.session.cost_usd).toBe(0.25);
  });

  it('puts Hermes plugin calls on the responses they made, by match key or by time, never an aux call', async () => {
    const hcall = (id: string, ts: string, match: string | null, input: number, entrypoint = 'telegram'): UsageCall => ({
      ...call(id, 'h1', '', 0), source: 'hermes', messageExternalId: null, ts: new Date(ts), model: 'deepseek-v4-flash',
      entrypoint, inputTokens: input, outputTokens: 7, thinkingTokens: 3, provider: 'openrouter', matchKey: match,
    });
    await withTransaction(async (tx) => {
      const h = (await tx.query<{ id: number }>(`SELECT id FROM archive_sessions WHERE external_id = 'h1'`)).rows[0]!.id;
      // Hermes saved different text than the plugin hashed: this one is matched by time.
      await archive.upsertMessages(tx, h, [m('msg:4', '2026-10-18T09:00:10Z', { id: 4, session_id: 'h1', role: 'assistant', content: 'All done.' })]);
      await usage.upsertCalls(tx, [
        hcall('req-1', '2026-10-18T09:00:01.900Z', 't:call_a', 500),
        hcall('req-2', '2026-10-18T09:00:08Z', 'c:0000', 600),
        hcall('req-3', '2026-10-18T09:00:09.500Z', null, 9, 'aux:title_generation'),
      ]);
    });
    const r = await request(app).get('/api/usage/agent-sessions/mac/h1').query({ source: 'hermes' });
    const chips = r.body.steps.filter((s: { call: unknown }) => s.call).map((s: { key: string; call: { input: number; reasoning: number } }) => [s.key, s.call.input, s.call.reasoning]);
    const id = (ext: string) => r.body.steps.find((s: { step: string; text: string }) => ext === 'msg:2' ? s.step === 'thinking' : s.text === 'All done.').id;
    expect(chips).toEqual([[`${id('msg:2')}:r`, 500, 3], [String(id('msg:4')), 600, 3]]);
    // Totals still come from Hermes's own counters, and the dashboard's call view stays Claude Code only.
    expect(r.body.session.input).toBe(1000);
    const facts = await withTransaction((tx) => tx.query(`SELECT count(*)::int AS n FROM usage_facts WHERE source <> 'claude-code'`));
    expect(facts.rows[0].n).toBe(0);
  });

  it('puts a Hermes call on one response only, across pages', async () => {
    await withTransaction(async (tx) => {
      const h = (await tx.query<{ id: number }>(`SELECT id FROM archive_sessions WHERE external_id = 'h1'`)).rows[0]!.id;
      await archive.upsertMessages(tx, h, [m('msg:4', '2026-10-18T09:00:04Z', { id: 4, session_id: 'h1', role: 'assistant', content: 'rewritten' })]);
      await usage.upsertCalls(tx, [{ ...call('req-1', 'h1', '', 0), source: 'hermes', messageExternalId: null,
        ts: new Date('2026-10-18T09:00:01.900Z'), inputTokens: 500, matchKey: 't:call_a' }]);
    });
    const steps: Array<{ call: unknown }> = [];
    for (let offset = 0, more = true; more; offset += 2) {
      const r = await request(app).get('/api/usage/agent-sessions/mac/h1').query({ source: 'hermes', limit: 2, offset });
      steps.push(...r.body.steps);
      more = r.body.next !== null;
    }
    // msg:4 is within two minutes of the call, but msg:2 owns it by key.
    expect(steps.filter((s) => s.call)).toHaveLength(1);
  });

  it('pages long sessions and can include meta rows', async () => {
    const p1 = await request(app).get('/api/usage/agent-sessions/mac/s1').query({ limit: '2' });
    expect(p1.body.steps).toHaveLength(2);
    expect(p1.body.next).toBe(2);
    const p2 = await request(app).get('/api/usage/agent-sessions/mac/s1').query({ limit: '2', offset: '2' });
    expect(p2.body.steps[0].step).toBe('tool_call');
    const all = await request(app).get('/api/usage/agent-sessions/mac/s1').query({ meta: '1' });
    expect(all.body.steps.some((s: { step: string }) => s.step === 'meta')).toBe(true);
  });

  it('lists a Hermes continuation on its own and keeps a subagent whose parent is missing', async () => {
    await withTransaction(async (tx) => {
      await archive.upsertSession(tx, sess({ source: 'hermes', externalId: 'h2', parentExternalId: 'h1', title: 'Stand-up (cont.)',
        startedAt: new Date('2026-10-18T11:00:00Z'), endedAt: new Date('2026-10-18T11:05:00Z'), messageCount: 0 }));
      const o = await archive.upsertSession(tx, sess({ externalId: 'agent-orphan', parentExternalId: 'gone', title: 'Orphan' }));
      await archive.upsertMessages(tx, o.id, [m('o1', '2026-10-18T12:00:00Z', cc('user', 'hi'), 'hi')]);
      await archive.refreshSessionStats(tx, o.id);
    });
    const ids = (await list()).body.sessions.map((x: { external_id: string }) => x.external_id);
    expect(ids).toEqual(['agent-orphan', 'h2', 's1', 'h1']);
  });

  it('puts a call\'s tokens only on its own session when another session reuses the record id', async () => {
    await withTransaction(async (tx) => {
      const other = await archive.upsertSession(tx, sess({ externalId: 's9', title: 'Resumed copy' }));
      await archive.upsertMessages(tx, other.id, [m('a2', '2026-10-18T13:00:00Z', cc('assistant', [{ type: 'text', text: 'copy' }]), 'copy')]);
    });
    const r = await request(app).get('/api/usage/agent-sessions/mac/s9');
    expect(r.body.steps[0].call).toBeNull();
  });

  it('answers 404 for an unknown session and 400 for a bad host', async () => {
    expect((await request(app).get('/api/usage/agent-sessions/mac/nope')).status).toBe(404);
    expect((await request(app).get('/api/usage/agent-sessions/Bad%20Host/s1')).status).toBe(400);
  });

  it('returns a message\'s full text on request', async () => {
    const r = await request(app).get('/api/usage/agent-sessions/mac/s1');
    const id = r.body.steps[0].id;
    const full = await request(app).get(`/api/usage/messages/${id}`).query({ full: '1' });
    expect(full.body.text).toBe('fix the usage page');
  });
});
