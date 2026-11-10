import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { sha256 } from '../src/archive/clean.js';
import * as archive from '../src/archive/store.js';
import type { ParsedMessage, SessionInput } from '../src/archive/types.js';
import { query, withTransaction } from '../src/db.js';
import * as usage from '../src/usage/store.js';
import type { UsageCall } from '../src/usage/types.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

// Sessions on /usage as an inspection tool: what type each session is (Telegram, a terminal, headless, another
// channel), which persona ran it, a one-line name, and context told apart from token totals. All data is made up.
const app = createApp({ modules: ALL_MODULES });
const T0 = '2026-11-10T07:13:00Z';

const sess = (over: Partial<SessionInput>): SessionInput => ({
  source: 'claude-code', host: 'mac', externalId: 'x', parentExternalId: null, project: null, title: null, model: null,
  startedAt: new Date(T0), endedAt: new Date('2026-11-10T07:43:00Z'), messageCount: 1, inputTokens: null, outputTokens: null,
  costUsd: null, meta: {}, b2Path: null, ...over,
});
let seq = 0;
const prompt = (text: string, role = 'user'): ParsedMessage => ({
  seq: ++seq, externalId: `m${seq}`, parentExternalId: null, role, kind: role, ts: new Date(T0), contentText: text,
  raw: { type: role, message: { content: text } }, rawSha: sha256(`${seq}${text}`), isSidechain: false,
});
const call = (over: Partial<UsageCall>): UsageCall => ({
  source: 'claude-code', host: 'mac', callId: `c${++seq}`, requestId: null, sessionExternalId: 'x', messageExternalId: null,
  ts: new Date(T0), model: 'claude-opus-5-5', entrypoint: 'cli', cwd: null, isSidechain: false,
  inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, thinkingTokens: 0, webSearchRequests: 0, ...over,
});

const REMINDER = '<system-reminder>\nContents of /home/someone/AGENTS.md (project instructions):\n# AGENTS.md\nrules\n</system-reminder>';
const SKILL = '<command-message>argo-daily-update is running…</command-message>\n<command-name>/argo-daily-update</command-name>';

async function seed(): Promise<void> {
  await withTransaction(async (tx) => {
    const add = async (s: Partial<SessionInput>, prompts: string[] = []) => {
      const r = await archive.upsertSession(tx, sess(s));
      if (prompts.length) await archive.upsertMessages(tx, r.id, prompts.map((p) => prompt(p)));
    };
    // A Claude Code Telegram bot: typed at a terminal entrypoint, but the channel decides.
    await add({ externalId: 'tg', host: 'droplet', title: 'Board check', meta: { channel: 'telegram', channel_bot: 'claude', entrypoint: 'cli' } },
      ['what is on the board?']);
    // A person at the terminal; the first prompt is all boilerplate.
    await add({ externalId: 'typed', meta: { entrypoint: 'cli' } }, [REMINDER, `${REMINDER}\nMake the sessions page faster`]);
    // A `claude -p` card run stored before meta carried the entrypoint: its calls say sdk-cli; the run names the persona.
    await add({ externalId: 'card-run', title: 'Something the model titled' }, [REMINDER]);
    // Remote Control keeps its channel; it is not a terminal session.
    await add({ externalId: 'rc', meta: { channel: 'remote-control', entrypoint: 'cli' } }, ['check the deploy']);
    // A skill run in a daily session that starts with /clear.
    await add({ externalId: 'skill', meta: { entrypoint: 'sdk-cli' } }, ['<command-name>/clear</command-name>', SKILL]);
    // Hermes: a cron job and a terminal chat.
    await add({ source: 'hermes', externalId: 'h-cron', host: 'droplet', title: 'Morning brief', meta: { source: 'cron', profile: 'main' } });
    await add({ source: 'hermes', externalId: 'h-cli', host: 'droplet', meta: { source: 'cli', profile: 'main' } }, ['summarise my notes']);
    // zen-agent: an interactive chat with a recorded context window, and an old trace that says nothing.
    await add({ source: 'zen-agent', externalId: 'z-chat', host: 'droplet', meta: { persona: 'sol', entrypoint: 'chat', context_window: 128000, dispatch: {} } },
      ['draft the stand-up']);
    await add({ source: 'zen-agent', externalId: 'z-old', host: 'droplet', meta: { persona: 'sol', dispatch: {} } }, ['hello']);
    await usage.upsertCalls(tx, [
      // Two calls on the Telegram session: the latest one is the context, not the sum.
      call({ host: 'droplet', sessionExternalId: 'tg', ts: new Date('2026-11-10T07:14:00Z'), inputTokens: 1000, cacheReadTokens: 20000, cacheWriteTokens: 500, outputTokens: 10 }),
      call({ host: 'droplet', sessionExternalId: 'tg', ts: new Date('2026-11-10T07:20:00Z'), inputTokens: 50, cacheReadTokens: 30000, cacheWriteTokens: 100, outputTokens: 20 }),
      // A subagent call on the same session is not the parent's context.
      call({ host: 'droplet', sessionExternalId: 'tg', ts: new Date('2026-11-10T07:30:00Z'), inputTokens: 5, cacheReadTokens: 9000, isSidechain: true }),
      call({ sessionExternalId: 'card-run', entrypoint: 'sdk-cli', inputTokens: 7 }),
    ]);
  });
  await query(`INSERT INTO org_agents (name, runtime, role, org_version) VALUES ('atlas', 'claude-code', 'Head', 'v') ON CONFLICT DO NOTHING`);
  await query(`INSERT INTO boards (slug, name) VALUES ('exo', 'Exo') ON CONFLICT DO NOTHING`);
  await query(`INSERT INTO cards (id, board_slug, title, assignee, created_by) VALUES ('t_abc123', 'exo', 'Usage sessions: Telegram inspection', 'atlas', 'atlas')`);
  await query(`INSERT INTO usage_runs (host, run_id, session_id, log_path, agent_name, runtime, task_id, started_at)
    VALUES ('mac', 'run-1', 'card-run', '/tmp/r.jsonl', 'rune', 'claude-code', 't_abc123', '${T0}')`);
}

beforeEach(async () => {
  await truncateAll();
  seq = 0;
  await seed();
});

const RANGE = { from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' };
type Row = Record<string, unknown> & { external_id: string };
const list = async (q: Record<string, string> = {}): Promise<Row[]> =>
  (await request(app).get('/api/usage/agent-sessions').query({ ...RANGE, ...q }).expect(200)).body.sessions;
const byId = async () => Object.fromEntries((await list()).map((r) => [r.external_id, r]));
const ids = async (q: Record<string, string>) => (await list(q)).map((r) => r.external_id).sort();

describe('session type', () => {
  it('comes from the channel, the run record and the harness entrypoint, never the machine', async () => {
    const s = await byId();
    expect(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.session_type]))).toEqual({
      tg: 'telegram', typed: 'cli', 'card-run': 'headless', rc: 'remote-control', skill: 'headless',
      'h-cron': 'headless', 'h-cli': 'cli', 'z-chat': 'cli', 'z-old': 'unknown',
    });
  });

  it('filters by type and keeps the other facets working beside it', async () => {
    expect(await ids({ type: 'telegram' })).toEqual(['tg']);
    expect(await ids({ type: 'cli' })).toEqual(['h-cli', 'typed', 'z-chat']);
    expect(await ids({ type: 'headless' })).toEqual(['card-run', 'h-cron', 'skill']);
    expect(await ids({ type: 'headless', harness: 'hermes' })).toEqual(['h-cron']);
    expect(await ids({ type: 'telegram', channel: 'telegram', host: 'droplet' })).toEqual(['tg']);
    expect(await ids({ type: 'remote-control' })).toEqual(['rc']);
  });
});

describe('persona', () => {
  it('names the run agent, the zen persona or the Telegram bot; a terminal session has none, anything else says unknown', async () => {
    const s = await byId();
    expect(s['card-run']!.persona).toBe('rune');
    expect(s['z-chat']!.persona).toBe('sol');
    expect(s.tg!.persona).toBe('claude');
    expect(s.typed!.persona).toBeNull();
    expect(await ids({ persona: 'rune' })).toEqual(['card-run']);
    expect(await ids({ persona: 'sol' })).toEqual(['z-chat', 'z-old']);
    expect(await ids({ persona: 'none' })).toEqual(['h-cli', 'typed']);
    expect(await ids({ persona: 'unknown', type: 'headless' })).toEqual(['h-cron', 'skill']);
  });

  it('serves type and persona facets next to the existing ones', async () => {
    const r = await request(app).get('/api/usage/agent-sessions/facets').query(RANGE).expect(200);
    expect(Object.keys(r.body.facets).sort()).toEqual(['channel', 'harness', 'host', 'persona', 'profile', 'provider', 'tool', 'type']);
    expect(r.body.facets.type).toEqual([{ value: 'cli', n: 3 }, { value: 'headless', n: 3 }, { value: 'remote-control', n: 1 },
      { value: 'telegram', n: 1 }, { value: 'unknown', n: 1 }]);
    expect(r.body.facets.persona).toEqual([{ value: 'unknown', n: 3 }, { value: 'none', n: 2 }, { value: 'sol', n: 2 },
      { value: 'claude', n: 1 }, { value: 'rune', n: 1 }]);
  });
});

describe('context and duration', () => {
  it('context is the latest main call, never the accumulated input; capacity only when recorded', async () => {
    const s = await byId();
    expect(s.tg).toMatchObject({ context_tokens: 30150, context_window: null, input: 1055, cache_read: 59000 });
    expect(s.tg!.context_at).toBe('2026-11-10T07:20:00.000Z');
    expect(s['z-chat']).toMatchObject({ context_tokens: null, context_window: 128000 });
    expect(s.typed).toMatchObject({ context_tokens: null, context_window: null });
    expect(s.tg).toMatchObject({ started_at: '2026-11-10T07:13:00.000Z', ended_at: '2026-11-10T07:43:00.000Z' });
  });

  it('the session page header carries the same fields', async () => {
    const r = await request(app).get('/api/usage/agent-sessions/droplet/tg').query({ source: 'claude-code' }).expect(200);
    expect(r.body.session).toMatchObject({ session_type: 'telegram', persona: 'claude', channel_bot: 'claude', context_tokens: 30150,
      context_window: null, display_title: 'Board check', title_source: 'title', models: ['claude-opus-5-5'] });
  });
});

describe('session titles', () => {
  it('is one line under 100 characters from the card, the skill, the title or the first real request', async () => {
    const s = await byId();
    expect(s['card-run']).toMatchObject({ display_title: 'Usage sessions: Telegram inspection', title_source: 'task' });
    expect(s.skill).toMatchObject({ display_title: 'argo-daily-update', title_source: 'skill' });
    expect(s.typed).toMatchObject({ display_title: 'Make the sessions page faster', title_source: 'prompt' });
    expect(s['h-cron']).toMatchObject({ display_title: 'Morning brief', title_source: 'title' });
    for (const r of Object.values(s)) {
      const t = r.display_title as string | null;
      if (t !== null) { expect(t.length).toBeLessThan(100); expect(t).not.toMatch(/\n|AGENTS\.md|system-reminder|command-name/); }
    }
  });
});
