import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ClassifyInput, ClassifyResult } from '../src/classify/types.js';
import { query } from '../src/db.js';
import { Dispatcher, inQuietHours, localTime, parseRunResult, primaryReason, routineDue, type Deps, type RunnerResult } from '../src/dispatch/index.js';
import { addWakeup, dm, getAgent, importOrg, openWakeups, post, unreadCounts } from '../src/org.js';
import { parseSettings } from '../src/settings.js';
import { truncateAll } from './helpers.js';

// The engine's dispatcher (docs/zen-runtime.md, section 8) against a fake zen-agent and a fake classifier.
/** The same roster with one routine on rune: imported by the routine tests only (a 00:00 routine is always due). */
const withRoutine = () => ({
  ...ORG,
  agents: { ...ORG.agents, rune: { ...ORG.agents.rune, routines: [{ name: 'standup', at: '00:00', task_file: 'routines/standup.md' }] } },
});

const ORG = {
  version: 'd-1',
  company: 'Test Co',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner' },
    rune: { role: 'Platform engineer', team: 'platform', reports_to: 'atlas', runtime: 'zen-agent' },
    bolt: { role: 'Writer', team: 'platform', reports_to: 'atlas', runtime: 'zen-agent' },
  },
  teams: { platform: { name: 'Platform', lead: 'atlas' } },
  channels: { 'all-hands': { members: '*', purpose: 'company-wide' } },
};

interface Call { cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number }

function fallthrough(input: ClassifyInput): ClassifyResult {
  return { decision: input.decision, schemaVersion: '1', action: 'fallthrough', answer: null, probabilities: null, confidence: null,
    model: null, latencyMs: null, inputTokens: null, costUsd: null, error: 'no-key', cached: false, id: null };
}

function harness(over: Partial<Deps['config']> = {}, settings: unknown = {}) {
  const vault = mkdtempSync(join(tmpdir(), 'sb-vault-'));
  const calls: Call[] = [];
  const classified: ClassifyInput[] = [];
  let answer: (input: ClassifyInput) => ClassifyResult = fallthrough;
  let result: RunnerResult = { code: 0, stdout: '▸ noise\n' + JSON.stringify({ text: 'posted a status', stopped: 'done', turns: 3 }) + '\n', stderr: '' };
  const now = new Date('2026-10-24T12:30:00Z');
  const d = new Dispatcher({
    runner: async (cmd, args, env, cwd, timeoutMs) => { calls.push({ cmd, args, env, cwd, timeoutMs }); return result; },
    classify: async (input) => { classified.push(input); return answer(input); },
    settings: parseSettings({ dispatch: settings }).dispatch,
    config: { orgTz: 'UTC', orgDispatchQuiet: null, orgDispatchDailyTokens: 0, orgDispatchParallel: 2, orgZenCommand: 'zen-agent', vaultRoot: vault, ...over },
    now: () => now,
    env: { PATH: '/usr/bin' },
  });
  return { d, vault, calls, classified, now, setAnswer: (f: typeof answer) => { answer = f; }, setResult: (r: RunnerResult) => { result = r; } };
}

const meta = (args: string[], key: string): string | undefined => {
  const i = args.findIndex((a, j) => a === '--meta' && args[j + 1]?.startsWith(`${key}=`));
  return i >= 0 ? args[i + 1]!.slice(key.length + 1) : undefined;
};
const flag = (args: string[], name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

beforeEach(async () => {
  await truncateAll();
  await importOrg(ORG);
});

describe('pure helpers', () => {
  it('reads the local clock in a zone', () => {
    const t = localTime(new Date('2026-10-24T23:30:00Z'), 'Asia/Tokyo'); // Sunday 08:30 in Tokyo
    expect(t).toEqual({ hhmm: '08:30', hour: 8, isoWeekday: 7 });
    expect(localTime(new Date('2026-10-24T23:30:00Z'), 'UTC')).toEqual({ hhmm: '23:30', hour: 23, isoWeekday: 6 });
  });
  it('quiet hours wrap past midnight', () => {
    expect(inQuietHours('01-07', 3)).toBe(true);
    expect(inQuietHours('01-07', 7)).toBe(false);
    expect(inQuietHours('22-06', 23)).toBe(true);
    expect(inQuietHours('22-06', 5)).toBe(true);
    expect(inQuietHours('22-06', 12)).toBe(false);
    expect(inQuietHours(null, 3)).toBe(false);
  });
  it('a routine is due once its time has passed on one of its days', () => {
    const t = { hhmm: '08:30', hour: 8, isoWeekday: 7 };
    expect(routineDue({ name: 'a', at: '06:30', task_file: 'x' }, t)).toBe(true);
    expect(routineDue({ name: 'a', at: '09:00', task_file: 'x' }, t)).toBe(false);
    expect(routineDue({ name: 'a', at: '06:30', days: [1, 2, 3, 4, 5], task_file: 'x' }, t)).toBe(false);
  });
  it('the primary reason follows the precedence', () => {
    expect(primaryReason([{ reason: 'dm' }, { reason: 'task' }, { reason: 'mention' }])).toBe('task');
    expect(primaryReason([{ reason: 'dm' }, { reason: 'routine' }])).toBe('dm');
    expect(primaryReason([{ reason: 'owner' }, { reason: 'handoff' }])).toBe('owner');
  });
  it('finds the run result among other stdout lines', () => {
    expect(parseRunResult('hello\n{"a":1}\n{"text":"done it","stopped":"done"}\n')).toEqual({ text: 'done it', stopped: 'done' });
    expect(parseRunResult('no json here')).toBeNull();
  });
});

describe('tick', () => {
  it('runs one zen-agent run for a DM and finishes the wakeup with the run id', async () => {
    const h = harness();
    await dm(await getAgent('atlas'), 'rune', 'please check the build', {});
    const r = await h.d.tick();
    expect(r).toMatchObject({ runs: 1, agents: 1, acks: 0, gated: 0, held: null, errors: [] });
    expect(h.calls).toHaveLength(1);
    const { cmd, args, env, cwd, timeoutMs } = h.calls[0]!;
    expect(cmd).toBe('zen-agent');
    expect(args.slice(0, 1)).toEqual(['run']);
    expect(flag(args, '--persona')).toBe('rune');
    expect(flag(args, '--tools')).toBe('org,skills,knowledge');
    expect(flag(args, '--max-turns')).toBe('8');
    expect(flag(args, '--max-tokens')).toBe('60000');
    expect(args).toContain('--json');
    expect(args).not.toContain('--handoff-file'); // no previous run, nothing parked
    expect(meta(args, 'run_id')).toBe('rune-20261024-123000');
    expect(JSON.parse(meta(args, 'reasons')!)).toEqual([{ reason: 'dm', ref: expect.any(String) }]);
    expect(meta(args, 'team')).toBe('platform');
    expect(env.ORG_AGENT).toBe('rune');
    expect(env.ORG_RUN).toBe('rune-20261024-123000');
    expect(cwd).toBe(h.vault);
    expect(timeoutMs).toBe(7 * 60_000);
    const { rows } = await query<{ claimed_by: string; result: string; done_at: Date }>(`SELECT claimed_by, result, done_at FROM org_wakeups WHERE agent_name = 'rune'`);
    expect(rows).toEqual([{ claimed_by: 'rune-20261024-123000', result: 'posted a status', done_at: expect.any(Date) }]);
    // The gate was asked (and fell through), then the outcome was logged.
    expect(h.classified.map((c) => c.decision)).toEqual(['wake-gate', 'run-outcome']);
    expect(h.classified[0]!.state).toMatchObject({ message: { author: 'atlas', body: 'please check the build' }, recipient: { name: 'rune' } });
    // The task file carried the message and was removed afterwards.
    expect(flag(args, '--file')).toMatch(/task\.md$/);
  });

  it('leaves bots on other runtimes alone', async () => {
    const h = harness();
    await dm(await getAgent('owner'), 'atlas', 'hello', {});
    const r = await h.d.tick();
    expect(r.runs).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect((await openWakeups('atlas')).map((w) => w.claimed_at)).toEqual([null]);
  });

  it('finishes an acknowledgement without a run', async () => {
    const h = harness();
    const atlas = await getAgent('atlas');
    const m = await post(atlas, 'all-hands', '@rune noted', { kind: 'ack' });
    // The trigger never wakes anyone for an ack; an older dispatcher or a hand-made wakeup still might.
    await query(`INSERT INTO org_wakeups (agent_name, reason, ref) VALUES ('rune', 'mention', $1)`, [String(m.id)]);
    const r = await h.d.tick();
    expect(r).toMatchObject({ runs: 0, acks: 1 });
    expect(h.calls).toHaveLength(0);
    expect(h.classified).toEqual([]);
    const { rows } = await query<{ result: string }>(`SELECT result FROM org_wakeups WHERE agent_name = 'rune'`);
    expect(rows).toEqual([{ result: 'ack' }]);
  });

  it('a wake-gate skip finishes the wakeup, runs nothing and leaves the message unread', async () => {
    const h = harness();
    h.setAnswer((i) => i.decision === 'wake-gate'
      ? { ...fallthrough(i), action: 'skip', answer: 'fyi', probabilities: { act: 0.02, answer: 0.03, fyi: 0.9, ack: 0.05 }, confidence: 0.93, error: null }
      : fallthrough(i));
    await dm(await getAgent('atlas'), 'rune', 'fyi: the build is green', {});
    const r = await h.d.tick();
    expect(r).toMatchObject({ runs: 0, gated: 1 });
    expect(h.calls).toHaveLength(0);
    const { rows } = await query<{ result: string }>(`SELECT result FROM org_wakeups WHERE agent_name = 'rune'`);
    expect(rows).toEqual([{ result: 'skipped by wake-gate p=0.93' }]);
    const unread = await unreadCounts(await getAgent('rune'));
    expect(Object.values(unread).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('the owner is never gated', async () => {
    const h = harness();
    h.setAnswer((i) => ({ ...fallthrough(i), action: 'skip', confidence: 0.99 }));
    await dm(await getAgent('owner'), 'rune', 'do it', {});
    const r = await h.d.tick();
    expect(r.runs).toBe(1);
    expect(h.classified.map((c) => c.decision)).toEqual(['run-outcome']);
  });

  it('materialises a due routine once, runs it with the routine text, and not again the same day', async () => {
    await importOrg(withRoutine());
    const h = harness();
    mkdirSync(join(h.vault, 'routines'));
    writeFileSync(join(h.vault, 'routines', 'standup.md'), 'Post the stand-up for your team.\n');
    const r1 = await h.d.tick();
    expect(r1).toMatchObject({ routines: 1, runs: 1 });
    const args = h.calls[0]!.args;
    expect(flag(args, '--tools')).toBe('org,knowledge,fs,skills');
    expect(flag(args, '--max-turns')).toBe('12');
    expect(JSON.parse(meta(args, 'reasons')!)).toEqual([{ reason: 'routine', ref: 'standup' }]);
    const r2 = await h.d.tick();
    expect(r2).toMatchObject({ routines: 0, runs: 0 });
    expect(await h.d.routines()).toBe(0);
  });

  it('a routine whose task file is missing is finished with the reason and never run', async () => {
    await importOrg(withRoutine());
    const h = harness();
    const r = await h.d.tick();
    expect(r).toMatchObject({ routines: 1, runs: 0 });
    expect(h.calls).toHaveLength(0);
    const { rows } = await query<{ result: string }>(`SELECT result FROM org_wakeups WHERE agent_name = 'rune' AND reason = 'routine'`);
    expect(rows).toEqual([{ result: 'routine task file missing: routines/standup.md' }]);
  });

  it('quiet hours add routines but start no run', async () => {
    await importOrg(withRoutine());
    const h = harness({ orgDispatchQuiet: '12-13' });
    await dm(await getAgent('atlas'), 'rune', 'please check the build', {});
    const r = await h.d.tick();
    expect(r).toMatchObject({ held: 'quiet', runs: 0, routines: 1 });
    expect(h.calls).toHaveLength(0);
    expect((await openWakeups('rune')).length).toBe(2); // the DM and the routine, both still open
  });

  it('the daily token cap holds every run', async () => {
    const h = harness({ orgDispatchDailyTokens: 1000 });
    await query(
      `INSERT INTO usage_calls (source, host, call_id, session_external_id, ts, model, input_tokens, output_tokens, run_id)
       VALUES ('zen-agent', 'droplet', 'c1', 's1', now(), 'm', 900, 200, 'bolt-20261024-010000')`);
    await dm(await getAgent('atlas'), 'rune', 'please check the build', {});
    const r = await h.d.tick();
    expect(r).toMatchObject({ held: 'budget', runs: 0 });
    expect(h.calls).toHaveLength(0);
  });

  it('a card wake uses `wake <card>`, the lane budget, the tier flags and a handoff from the previous run', async () => {
    const h = harness({}, { tiers: { mid: { model: 'openrouter/some/model', thinking: 'low' } } });
    h.setAnswer((i) => i.decision === 'card-tier'
      ? { ...fallthrough(i), action: 'act', answer: 'mid', confidence: 0.9, error: null }
      : fallthrough(i));
    // The board module's record: task_links is a view over cards, and truncateAll empties the seeded board.
    await query(`INSERT INTO boards (slug, name) VALUES ('exo', 'Exo') ON CONFLICT DO NOTHING`);
    await query(`INSERT INTO cards (id, board_slug, title, assignee, created_by, work_type) VALUES ('t_abc123', 'exo', 'Fix the build', 'rune', 'atlas', 'coding')`);
    await query(
      `INSERT INTO usage_runs (host, run_id, session_id, log_path, agent_name, runtime, task_id, started_at, ended_at, subtype, num_turns, total_cost_usd)
       VALUES ('droplet', 'rune-20261023-090000', 'rune-20261023-090000-ab12', '/srv/vault/.zen/sessions/x.jsonl', 'rune', 'zen-agent', 't_abc123',
               '2026-10-23T09:00:00Z', '2026-10-23T09:12:00Z', 'budget', 30, 0.0412)`);
    expect(await addWakeup('rune', 'task', 't_abc123')).toEqual(expect.any(Number));
    await dm(await getAgent('atlas'), 'rune', 'the card is yours', {}); // rides along in the task file
    h.setResult({ code: 3, stdout: JSON.stringify({ text: 'BLOCKED: out of turns', stopped: 'budget' }), stderr: '' });
    const r = await h.d.tick();
    expect(r.runs).toBe(1);
    const args = h.calls[0]!.args;
    expect(args.slice(0, 2)).toEqual(['wake', 't_abc123']);
    expect(flag(args, '--task-file')).toMatch(/task\.md$/);
    expect(flag(args, '--handoff-file')).toMatch(/handoff\.md$/);
    expect(flag(args, '--tools')).toBe('fs,shell,skills,knowledge,kanban,org,subagent');
    expect(flag(args, '--max-turns')).toBe('30'); // rune is a member, not a lead
    expect(flag(args, '--model')).toBe('openrouter/some/model');
    expect(flag(args, '--thinking')).toBe('low');
    expect(meta(args, 'tier')).toBe('mid');
    expect(meta(args, 'task_id')).toBe('t_abc123');
    expect(JSON.parse(meta(args, 'reasons')!)).toEqual([{ reason: 'task', ref: 't_abc123' }, { reason: 'dm', ref: expect.any(String) }]);
    expect(h.classified.map((c) => c.decision)).toEqual(['wake-gate', 'card-tier', 'run-outcome']);
    expect(h.classified[1]!.state).toMatchObject({ card: 't_abc123', title: 'Fix the build', work_type: 'coding' });
    // Both wakeups done; a second budget stop on the same card says so.
    const { rows } = await query<{ reason: string; result: string }>(`SELECT reason, result FROM org_wakeups WHERE agent_name = 'rune' ORDER BY id`);
    expect(rows).toEqual([
      { reason: 'task', result: 'BLOCKED: out of turns (held: budget twice)' },
      { reason: 'dm', result: 'BLOCKED: out of turns (held: budget twice)' },
    ]);
  });

  it('a lead gets the larger card budget and settings override tools and budgets', async () => {
    const h = harness({}, { budgets: { dm: { turns: 3, tokens: 1000, minutes: 1 } }, tools: { dm: ['org'] } });
    await dm(await getAgent('atlas'), 'rune', 'hi', {});
    await h.d.tick();
    const args = h.calls[0]!.args;
    expect(flag(args, '--tools')).toBe('org');
    expect(flag(args, '--max-turns')).toBe('3');
    expect(h.calls[0]!.timeoutMs).toBe(3 * 60_000);
  });

  it('two cards for one bot: one runs, the other is released for the next tick', async () => {
    const h = harness();
    await addWakeup('bolt', 'task', 't_aaa111');
    await addWakeup('bolt', 'task', 't_bbb222');
    const r = await h.d.tick();
    expect(r.runs).toBe(1);
    expect(h.calls[0]!.args.slice(0, 2)).toEqual(['wake', 't_aaa111']);
    const { rows } = await query<{ ref: string; done: boolean; claimed: boolean }>(
      `SELECT ref, done_at IS NOT NULL AS done, claimed_at IS NOT NULL AS claimed FROM org_wakeups WHERE agent_name = 'bolt' ORDER BY id`);
    expect(rows).toEqual([{ ref: 't_aaa111', done: true, claimed: true }, { ref: 't_bbb222', done: false, claimed: false }]);
  });

  it('a run that died is released after the longest budget', async () => {
    const h = harness();
    await dm(await getAgent('atlas'), 'bolt', 'x', {});
    await query(`UPDATE org_wakeups SET claimed_at = now() - interval '2 hours', claimed_by = 'dead-run'`);
    const r = await h.d.tick();
    expect(r.released).toBe(1);
    expect(r.runs).toBe(1); // picked up again in the same tick
  });
});
