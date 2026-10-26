import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { ALL_MODULES, truncateAll } from './helpers.js';
import { buildRunning, modelOf, parseEtime, parsePsLine, runtimeOf, type Claim, type Proc } from '../src/usage/running.js';

// Command lines in the shapes `ps` prints on a server.
const FUND = '/bin/bash /home/agent/.local/bin/claude -p /nightly-report --output-format stream-json --verbose --model sonnet --permission-mode acceptEdits';
const FUND_SH = '/bin/sh -c JOB_DIR=/home/agent/vault/jobs /home/agent/bin/job-run nightly-report   # cron';
const RC = '/bin/bash /home/agent/.local/bin/claude remote-control --spawn same-dir --capacity 2 --permission-mode acceptEdits';
const ZEN_SERVE = '/usr/bin/node --no-warnings /home/agent/zen-agent/dist/src/cli.js serve --port 8791 --host 127.0.0.1';

const proc = (pid: number, args: string, env: Record<string, string> = {}, elapsedSec = 60): Proc => ({ pid, user: 'agent', elapsedSec, args, env });
const roster = new Map([
  ['atlas', { runtime: 'claude-code', model: 'opus' }],
  ['rune', { runtime: 'zen-agent', model: 'openrouter/deepseek/deepseek-v4.1-flash' }],
]);

describe('ps parsing', () => {
  it('reads etime in every shape ps prints', () => {
    expect(parseEtime('00:09')).toBe(9);
    expect(parseEtime('02:42:20')).toBe(9740);
    expect(parseEtime('134-04:58:49')).toBe(134 * 86400 + 4 * 3600 + 58 * 60 + 49);
    expect(parseEtime('nonsense')).toBe(0);
  });

  it('splits a line into pid, user, elapsed and the whole command', () => {
    expect(parsePsLine(` 4124926 agent     16:34 /usr/bin/python3 -m cc_dispatcher`)).toEqual(
      { pid: 4124926, user: 'agent', elapsedSec: 994, args: '/usr/bin/python3 -m cc_dispatcher' });
    expect(parsePsLine('')).toBeNull();
  });
});

describe('what counts as an agent process', () => {
  it('takes the claude wrapper and not the shell that launched it', () => {
    expect(runtimeOf(FUND)).toBe('claude-code');
    expect(runtimeOf(RC)).toBe('claude-code');
    expect(runtimeOf(FUND_SH)).toBeNull();
    expect(runtimeOf('sleep infinity')).toBeNull();
  });

  it('knows zen-agent, hermes and the dispatcher is not an agent', () => {
    expect(runtimeOf(ZEN_SERVE)).toBe('zen-agent');
    expect(runtimeOf('node /home/agent/zen-agent/dist/src/cli.js wake t_1 --json')).toBe('zen-agent');
    expect(runtimeOf('/home/agent/.local/bin/hermes -p writer chat -q hi')).toBe('hermes');
    expect(runtimeOf('/usr/bin/python3 -m cc_dispatcher')).toBeNull();
    expect(runtimeOf('postgres: 16/main: agent vaultdb [local] idle')).toBeNull();
  });

  it('reads the model flag in both spellings', () => {
    expect(modelOf(FUND)).toBe('sonnet');
    expect(modelOf('claude -p x --model=opus')).toBe('opus');
    expect(modelOf(RC)).toBeNull();
  });
});

describe('buildRunning', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  const claim = (runId: string, agent: string, claimedAt = '2026-10-26T11:59:00Z'): Claim =>
    ({ runId, agent, reason: 'task', ref: 't_9', claimedAt: new Date(claimedAt) });

  it('labels a bot run from its environment and joins the wakeup that started it', () => {
    const rows = buildRunning([proc(1, 'claude -p go --model opus', { ORG_AGENT: 'atlas', ORG_RUN: 'atlas-1' })], [claim('atlas-1', 'atlas')], roster, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'bot', name: 'atlas', runtime: 'claude-code', model: 'opus', reason: 'task', ref: 't_9', state: 'running',
      configured: { runtime: 'claude-code' } });
  });

  it('shows what the roster says next to what is actually running', () => {
    // rune is configured for zen-agent but a claude process carries its name: the page shows both
    const rows = buildRunning([proc(2, 'claude -p go', { ORG_AGENT: 'rune', ORG_RUN: 'rune-1' })], [], roster, now);
    expect(rows[0]).toMatchObject({ name: 'rune', runtime: 'claude-code', configured: { runtime: 'zen-agent' } });
  });

  it('lists lane workers and unlabelled sessions apart from bots', () => {
    const rows = buildRunning([
      proc(3, RC), proc(4, FUND), proc(5, ZEN_SERVE), proc(6, FUND_SH),
      proc(7, 'claude -p card', { CC_LANE: 'cc-coder' }), proc(8, 'claude -p x', { ORG_AGENT: 'atlas', ORG_RUN: 'a' }),
    ], [], roster, now);
    expect(rows.map((r) => [r.kind, r.name])).toEqual([
      ['bot', 'atlas'], ['lane', 'cc-coder'],
      ['other', 'Remote Control server'], ['other', 'claude -p /nightly-report'], ['other', 'zen-agent serve'],
    ]);
  });

  it('flags a claimed wakeup that no process carries', () => {
    const rows = buildRunning([], [claim('sol-1', 'sol', '2026-10-26T11:30:00Z')], new Map([['sol', { runtime: 'claude-code', model: 'opus' }]]), now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'bot', name: 'sol', state: 'claimed', pid: null, elapsedSec: 1800, runId: 'sol-1' });
    expect(rows[0]!.detail).toMatch(/stale/);
  });

  it('puts the longest run first within a kind', () => {
    const rows = buildRunning([
      proc(1, 'claude -p a', { ORG_AGENT: 'atlas', ORG_RUN: 'a' }, 10), proc(2, 'claude -p b', { ORG_AGENT: 'rune', ORG_RUN: 'b' }, 500)], [], roster, now);
    expect(rows.map((r) => r.name)).toEqual(['rune', 'atlas']);
  });
});

describe('GET /api/usage/running', () => {
  const app = createApp({ modules: ALL_MODULES });
  beforeEach(async () => { await truncateAll(); await query(`TRUNCATE org_agents, org_wakeups RESTART IDENTITY CASCADE`); });

  it('lists an unfinished claim as claimed, skips a finished one, and counts the roster by runtime', async () => {
    await query(`INSERT INTO org_agents (name, runtime, role, model, org_version) VALUES
      ('atlas', 'claude-code', 'Head', 'opus', 'v'), ('rune', 'zen-agent', 'Eng', 'openrouter/x/y', 'v'), ('owner', 'human', 'CEO', NULL, 'v')`);
    await query(`INSERT INTO org_wakeups (agent_name, reason, ref, claimed_at, claimed_by, done_at) VALUES
      ('atlas', 'task', 't_1', now() - interval '3 minutes', 'atlas-open', NULL),
      ('rune', 'dm', '7', now() - interval '1 hour', 'rune-done', now() - interval '59 minutes')`);
    const res = await request(app).get('/api/usage/running');
    expect(res.status).toBe(200);
    expect(res.body.configured).toEqual({ 'claude-code': 1, 'zen-agent': 1 });
    const claimed = res.body.rows.filter((r: { state: string }) => r.state === 'claimed');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ name: 'atlas', runId: 'atlas-open', reason: 'task', ref: 't_1', runtime: 'claude-code', model: 'opus' });
    expect(claimed[0].elapsedSec).toBeGreaterThanOrEqual(179);
  });
});
