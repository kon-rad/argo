import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { tokensToday } from '../src/addons/dispatch/store.js';
import { createApp } from '../src/app.js';
import { backfillBots } from '../src/archive/bot.js';
import * as archive from '../src/archive/store.js';
import { query, withTransaction } from '../src/db.js';
import { ingestBatch } from '../src/ingest/batch.js';
import { importLines } from '../src/usage/importer.js';
import { buildPush } from '../src/usage/push.js';
import * as store from '../src/usage/store.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

// A chat a person starts with a roster bot on any machine (`claude --agent <name>`, Agent Dock's Codex and Hermes
// chats, a zen-agent chat) is labelled with that bot at import time and shown on /usage as the bot's owner chat,
// never as a wake. Every name here is made up.

const HOST = 'laptop-a';
const now = Date.now();
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const L = (o: unknown) => JSON.stringify(o) + '\n';
const persona = (name: string) => `# ${name}, Engineer at Example\n\nYou are **${name}**, Engineer on the Example team.\n\nBe brief.`;

function claudeTranscript(sid: string, agent: string | null): string {
  return (agent ? L({ type: 'agent-setting', agentSetting: agent, sessionId: sid }) : '')
    + L({ type: 'user', uuid: `${sid}-u1`, timestamp: at(30), sessionId: sid, entrypoint: 'cli', message: { role: 'user', content: 'tidy the notes' } })
    + L({ type: 'assistant', uuid: `${sid}-a1`, timestamp: at(29), sessionId: sid, entrypoint: 'cli',
      message: { id: `msg-${sid}`, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 100, output_tokens: 10 } } });
}

function codexSession(sid: string, firstPrompt: string): string {
  return L({ timestamp: at(20), type: 'session_meta', payload: { id: sid, source: 'cli', cwd: '/work', model: 'gpt-5.5' } })
    + L({ timestamp: at(20), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/work</cwd>\n</environment_context>' }] } })
    + L({ timestamp: at(19), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: firstPrompt }] } })
    + L({ timestamp: at(18), type: 'response_item', payload: { type: 'message', role: 'assistant', id: `${sid}-a`, content: [{ type: 'output_text', text: 'ok' }] } })
    + L({ timestamp: at(18), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 200, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 } } } });
}

function zenTrace(id: string, personaName: string, dispatch: Record<string, unknown>): string {
  return L({ type: 'meta', version: 1, id, at: at(10), persona: personaName, model: 'ollama/qwen3:8b', parts: [], parent: null, dispatch, entrypoint: 'chat' })
    + L({ type: 'message', at: at(10), message: { role: 'user', content: 'plan my week', timestamp: at(10) } })
    + L({ type: 'message', at: at(9), message: { role: 'assistant', content: [{ type: 'text', text: 'here' }], model: 'qwen3:8b', provider: 'ollama',
      usage: { input: 300, output: 30, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, timestamp: at(9) } })
    + L({ type: 'end', at: at(8), stopped: 'done', turns: 1, usage: { cost: 0 } });
}

async function roster(): Promise<void> {
  await query(`INSERT INTO org_agents (name, runtime, role, org_version) VALUES
    ('ada', 'claude-code', 'Engineer', 'v'), ('bolt', 'codex', 'Engineer', 'v'), ('cleo', 'hermes', 'Writer', 'v'),
    ('dex', 'claude-code', 'Researcher', 'v'), ('owner', 'human', 'CEO', 'v')`);
}

/** One dispatcher wake for ada on the server: a run, its claimed wakeup, one call in the run. */
async function dispatcherWake(): Promise<void> {
  await query(`INSERT INTO org_wakeups (agent_name, reason, ref, created_at, claimed_at, claimed_by, done_at)
               VALUES ('ada', 'mention', '7', $1, $1, 'org-ada-run-1', $2)`, [at(61), at(55)]);
  await withTransaction(async (tx) => {
    await store.upsertRuns(tx, [{
      host: 'droplet', runId: 'org-ada-run-1', sessionId: 'wake-sess', agentName: 'ada', teamSlug: null, workType: null,
      reasons: [{ reason: 'mention', ref: '7' }], wakeupIds: [1], resumed: false, taskId: null, board: null, lane: null, model: 'claude-opus-5-5',
      startedAt: new Date(at(60)), endedAt: new Date(at(56)), durationMs: 240_000, durationApiMs: null, numTurns: 2, subtype: 'success',
      isError: false, totalCostUsd: null, usage: null, modelUsage: null, verify: null, logPath: '/runs/org-ada-run-1.jsonl',
    }]);
    await store.upsertCalls(tx, [{
      source: 'claude-code', host: 'droplet', callId: 'msg-wake', requestId: null, sessionExternalId: 'wake-sess', messageExternalId: null,
      ts: new Date(at(58)), model: 'claude-opus-5-5', entrypoint: 'sdk-cli', cwd: null, isSidechain: false,
      inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 50, thinkingTokens: 0, webSearchRequests: 0, tool: null, action: null,
    }]);
    await store.attachCallsToRuns(tx, 'droplet');
  });
}

/** A Hermes chat from a laptop's ledger: the session, its messages and its counters, as the ledger sends them. */
async function hermesChat(sid: string, firstPrompt: string): Promise<void> {
  await query(`INSERT INTO usage_hosts (slug, display, kind) VALUES ($1, $1, 'laptop') ON CONFLICT DO NOTHING`, [HOST]);
  const dev = await query<{ id: number }>(`INSERT INTO ingest_devices (host, token_hash) VALUES ($1, $2) RETURNING id`, [HOST, `hash-${sid}`]);
  const msg = (seq: number, role: string, text: string) => ({ seq, kind: 'message', key: `hermes|${sid}|msg:${seq}`, data: {
    sessionExternalId: sid, seq, externalId: `msg:${seq}`, parentExternalId: null, role, kind: role, ts: at(40 - seq),
    contentText: text, raw: { role, content: text }, rawSha: `sha-${sid}-${seq}`, isSidechain: false } });
  await ingestBatch({ id: Number(dev.rows[0]!.id), host: HOST }, {
    v: 1, ledgerId: `ledger-${sid}`, bundle: 'test', fromSeq: 1, toSeq: 4,
    rows: [
      { seq: 1, kind: 'session', key: `hermes|${sid}`, data: { source: 'hermes', externalId: sid, title: null, model: 'deepseek-v4-flash',
        startedAt: at(40), endedAt: at(35), meta: { profile: 'main', source: 'cli' } } },
      msg(2, 'user', firstPrompt) as never, msg(3, 'assistant', 'sure') as never,
      { seq: 4, kind: 'counter', key: `main|${sid}`, data: { profile: 'main', sessionId: sid, model: 'deepseek-v4-flash', billingProvider: 'deepseek',
        startedAt: at(40), endedAt: at(35), inputTokens: 400, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, apiCalls: 2, costUsd: 0.001 } },
    ],
  });
}

let dir: string;
const dirs = () => ({ claude: join(dir, 'claude'), codex: join(dir, 'codex'), zen: join(dir, 'zen') });
const bots = async () => Object.fromEntries((await query<{ source: string; external_id: string; bot: string | null }>(
  `SELECT source, external_id, bot FROM archive_sessions ORDER BY external_id`)).rows.map((r) => [r.external_id, r.bot]));

/** Every harness's laptop files, pushed and imported the way the LaunchAgent does it. */
async function pushLaptop(): Promise<void> {
  const push = buildPush({ claudeProjectsDir: dirs().claude, codexSessionsDir: dirs().codex, zenSessionsDir: dirs().zen, planLog: null, maxBytes: 10_000_000, host: HOST }, { files: {} });
  const counts = await importLines(push.lines, HOST);
  expect(counts.errors).toEqual([]);
}

beforeEach(async () => {
  await truncateAll();
  await roster();
  dir = mkdtempSync(join(tmpdir(), 'usage-bot-'));
  for (const d of Object.values(dirs())) mkdirSync(d, { recursive: true });
  mkdirSync(join(dirs().claude, 'proj', 'claude-1', 'subagents'), { recursive: true });
  writeFileSync(join(dirs().claude, 'proj', 'claude-1.jsonl'), claudeTranscript('claude-1', 'ada'));
  writeFileSync(join(dirs().claude, 'proj', 'claude-1', 'subagents', 'agent-sub1.jsonl'), claudeTranscript('agent-sub1', null));
  writeFileSync(join(dirs().claude, 'proj', 'claude-plain.jsonl'), claudeTranscript('claude-plain', null));
  writeFileSync(join(dirs().claude, 'proj', 'claude-other.jsonl'), claudeTranscript('claude-other', 'Explore'));
  writeFileSync(join(dirs().codex, 'rollout-codex-1.jsonl'), codexSession('codex-1', persona('bolt')));
  writeFileSync(join(dirs().codex, 'rollout-codex-x.jsonl'), codexSession('codex-x', persona('mallory')));
  writeFileSync(join(dirs().codex, 'rollout-codex-q.jsonl'), codexSession('codex-q', `please explain this line:\nYou are **bolt**, Engineer on the Example team.`));
  writeFileSync(join(dirs().zen, 'zen-1.jsonl'), zenTrace('zen-1', 'dex', {}));
});

describe('importing chats a person started with a bot', () => {
  it('labels one session per harness with its roster bot (Claude, Codex, Hermes, zen-agent)', async () => {
    await pushLaptop();
    await hermesChat('hermes-1', persona('cleo'));
    const b = await bots();
    expect(b['claude-1']).toBe('ada');        // agent-setting
    expect(b['agent-sub1']).toBe('ada');      // its subagent, from the parent
    expect(b['codex-1']).toBe('bolt');        // persona line in the first prompt, after Codex's own environment message
    expect(b['hermes-1']).toBe('cleo');       // persona line in the first user message
    expect(b['zen-1']).toBe('dex');           // the trace's persona
  });

  it('never stores a name outside the roster, and leaves sessions with no persona unattributed', async () => {
    await pushLaptop();
    await hermesChat('hermes-owner', persona('owner'));   // the human, not a bot
    await hermesChat('hermes-plain', 'what is on my calendar');
    const b = await bots();
    expect(b['codex-x']).toBeNull();          // "You are **mallory**": not in the roster
    expect(b['claude-other']).toBeNull();     // agent-setting of a Claude Code built-in, not a roster bot
    expect(b['claude-plain']).toBeNull();
    expect(b['codex-q']).toBeNull();          // a persona line that does not open the message is a quote, not the persona
    expect(b['hermes-owner']).toBeNull();
    expect(b['hermes-plain']).toBeNull();
    await expect(query(`UPDATE archive_sessions SET bot = 'mallory' WHERE external_id = 'codex-x'`)).rejects.toThrow(/foreign key/);
  });

  it('a laptop zen-agent chat is in the push and arrives without a run, so no wake and no daily token cap', async () => {
    const push = buildPush({ claudeProjectsDir: dirs().claude, zenSessionsDir: dirs().zen, planLog: null, maxBytes: 10_000_000, host: HOST }, { files: {} });
    const zen = push.lines.map((l) => JSON.parse(l)).filter((w) => w.t === 'zen');
    expect(zen).toHaveLength(1);
    expect(zen[0].path).toBe(join(dirs().zen, 'zen-1.jsonl'));
    // Unchanged file: not sent again. A grown one: sent again, whole.
    expect(buildPush({ claudeProjectsDir: dirs().claude, zenSessionsDir: dirs().zen, planLog: null, maxBytes: 10_000_000 }, push.next).lines
      .filter((l) => JSON.parse(l).t === 'zen')).toHaveLength(0);

    const c = await importLines(push.lines, HOST);
    expect(c).toMatchObject({ errors: [] });
    expect(c.calls).toBeGreaterThan(0);
    await importLines(push.lines, HOST); // a resend after a lost SSH reply changes nothing
    expect((await query(`SELECT count(*)::int n FROM usage_calls WHERE source = 'zen-agent'`)).rows[0]!.n).toBe(1);
    expect((await query(`SELECT count(*)::int n FROM usage_runs`)).rows[0]!.n).toBe(0);
    expect((await query(`SELECT run_id FROM usage_calls WHERE source = 'zen-agent'`)).rows).toEqual([{ run_id: null }]);
    expect((await query(`SELECT agent_name, surface FROM usage_facts WHERE source = 'zen-agent'`)).rows).toEqual([{ agent_name: 'dex', surface: 'owner-chat' }]);
  });

  it('a zen-agent trace a dispatcher started keeps its run when it comes from a laptop', async () => {
    writeFileSync(join(dirs().zen, 'zen-1.jsonl'), zenTrace('zen-1', 'dex', { run_id: 'dex-run-1', reasons: '[{"reason":"dm","ref":"3"}]' }));
    await pushLaptop();
    expect((await query(`SELECT run_id, agent_name FROM usage_runs`)).rows).toEqual([{ run_id: 'dex-run-1', agent_name: 'dex' }]);
    expect((await query(`SELECT agent_name, surface, run_id FROM usage_facts WHERE source = 'zen-agent'`)).rows).toEqual([{ agent_name: 'dex', surface: 'bot', run_id: 'dex-run-1' }]);
  });
});

describe('/usage with owner chats', () => {
  const app = createApp({ modules: ALL_MODULES });
  const range = { from: new Date(now - 86400_000).toISOString(), to: new Date(now + 3600_000).toISOString() };

  it('leaves a dispatcher wake and its counts as they were', async () => {
    await dispatcherWake();
    // The wake's own transcript names the bot too (`claude -p --agent ada`): the run's label still decides.
    await withTransaction(async (tx) => {
      const s = await archive.upsertSession(tx, { source: 'claude-code', host: 'droplet', externalId: 'wake-sess', parentExternalId: null, project: null,
        title: null, model: null, startedAt: null, endedAt: null, messageCount: null, inputTokens: null, outputTokens: null, costUsd: null, meta: {}, b2Path: null });
      await archive.upsertMessages(tx, s.id, [{ seq: 1, externalId: 'line:1', parentExternalId: null, role: 'meta', kind: 'agent-setting', ts: null,
        contentText: '', raw: { type: 'agent-setting', agentSetting: 'ada' }, rawSha: 'x', isSidechain: false }]);
    });
    await backfillBots();
    const before = {
      wakes: (await request(app).get('/api/usage/org-wakes').query(range)).body.agents,
      cap: await tokensToday('UTC'),
      facts: (await query(`SELECT surface, agent_name, reason, run_id FROM usage_facts WHERE host = 'droplet'`)).rows,
    };
    expect(before.wakes).toEqual([expect.objectContaining({ agent_name: 'ada', wakes: 1, mention: 1, tokens: 1050 })]);
    expect(before.facts).toEqual([{ surface: 'bot', agent_name: 'ada', reason: 'mention', run_id: 'org-ada-run-1' }]);

    await pushLaptop();
    await hermesChat('hermes-1', persona('cleo'));

    expect((await request(app).get('/api/usage/org-wakes').query(range)).body.agents).toEqual(before.wakes);
    expect(await tokensToday('UTC')).toBe(before.cap);
    expect((await query(`SELECT surface, agent_name, reason, run_id FROM usage_facts WHERE host = 'droplet'`)).rows).toEqual(before.facts);
    expect((await query(`SELECT count(*)::int n FROM org_wakeups`)).rows[0]!.n).toBe(1);
  });

  it('lists a bot\'s owner chats under the bot, in the sessions filter and the by-bot totals', async () => {
    await dispatcherWake();
    await pushLaptop();
    await hermesChat('hermes-1', persona('cleo'));

    const ada = (await request(app).get('/api/usage/sessions').query({ ...range, agent: 'ada' })).body.sessions;
    expect(ada.map((s: { external_id: string; surface: string }) => [s.external_id, s.surface]).sort()).toEqual([
      ['agent-sub1', 'owner-chat'], ['claude-1', 'owner-chat'], ['wake-sess', 'bot']]);
    const chats = (await request(app).get('/api/usage/sessions').query({ ...range, agent: 'ada', surface: 'owner-chat' })).body.sessions;
    expect(chats.map((s: { external_id: string }) => s.external_id).sort()).toEqual(['agent-sub1', 'claude-1']);
    for (const [bot, sid, source] of [['bolt', 'codex-1', 'codex'], ['cleo', 'hermes-1', 'hermes'], ['dex', 'zen-1', 'zen-agent']]) {
      const rows = (await request(app).get('/api/usage/sessions').query({ ...range, agent: bot })).body.sessions;
      expect(rows).toEqual([expect.objectContaining({ external_id: sid, source, host: HOST, agent_name: bot, surface: 'owner-chat' })]);
    }

    // By-bot totals: the agent facet counts each bot's owner chats; the wake panel still counts only wakes.
    const facets = (await request(app).get('/api/usage/facets').query(range)).body.facets;
    const tokens = Object.fromEntries(facets.agent.map((f: { value: string; tokens: number }) => [f.value, f.tokens]));
    expect(tokens).toMatchObject({ ada: 1050 + 110 + 110, bolt: 220, cleo: 440, dex: 330 });
    expect(facets.surface.find((f: { value: string }) => f.value === 'owner-chat').tokens).toBe(110 + 110 + 220 + 440 + 330);
    const wakes = (await request(app).get('/api/usage/org-wakes').query(range)).body.agents;
    expect(wakes).toEqual([expect.objectContaining({ agent_name: 'ada', wakes: 1, tokens: 1050 })]);

    // The sessions viewer's persona filter finds them too.
    const viewer = (await request(app).get('/api/usage/agent-sessions').query({ ...range, persona: 'bolt' })).body;
    expect(viewer.sessions.map((s: { external_id: string }) => s.external_id)).toEqual(['codex-1']);
  });
});

describe('usage-backfill --bots', () => {
  it('labels sessions imported before the column existed, and takes the agent off old zen-agent chat runs', async () => {
    await pushLaptop();
    await hermesChat('hermes-1', persona('cleo'));
    // As they were before this change: no bot anywhere, and a server zen chat whose run carried the persona.
    await query(`UPDATE archive_sessions SET bot = NULL`);
    await withTransaction(async (tx) => {
      await store.upsertRuns(tx, [{
        host: HOST, runId: 'zen-1', sessionId: 'zen-1', agentName: 'dex', teamSlug: null, workType: null, reasons: [], wakeupIds: [], resumed: false,
        taskId: null, board: null, lane: null, model: 'ollama/qwen3:8b', startedAt: new Date(at(10)), endedAt: new Date(at(8)), durationMs: 120_000,
        durationApiMs: null, numTurns: 1, subtype: 'done', isError: false, totalCostUsd: 0, usage: null, modelUsage: null, verify: null, logPath: '/x', runtime: 'zen-agent',
      }]);
    });
    const r = await backfillBots(2);
    expect(r).toMatchObject({ labelled: 5, zenRuns: 1 });
    expect(await bots()).toMatchObject({ 'claude-1': 'ada', 'agent-sub1': 'ada', 'codex-1': 'bolt', 'hermes-1': 'cleo', 'zen-1': 'dex', 'codex-x': null });
    expect((await query(`SELECT agent_name FROM usage_runs WHERE run_id = 'zen-1'`)).rows).toEqual([{ agent_name: null }]);
    // Again: nothing left to do.
    expect(await backfillBots()).toMatchObject({ labelled: 0, zenRuns: 0 });
  });
});
