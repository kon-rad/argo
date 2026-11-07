import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ClassifyInput, ClassifyResult } from '../src/addons/classify/types.js';
import { query } from '../src/db.js';
import { createCard, getCard, moveCard, setOverride } from '../src/board.js';
import { Dispatcher, inQuietHours, isProviderError, localTime, machineOf, parseRunResult, primaryReason, providerOf, routineDue, type Deps, type RunnerResult } from '../src/addons/dispatch/index.js';
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
  let result: RunnerResult | ((args: string[]) => RunnerResult) = { code: 0, stdout: '▸ noise\n' + JSON.stringify({ text: 'posted a status', stopped: 'done', turns: 3 }) + '\n', stderr: '' };
  const now = new Date('2026-10-24T12:30:00Z');
  const d = new Dispatcher({
    runner: async (cmd, args, env, cwd, timeoutMs) => { calls.push({ cmd, args, env, cwd, timeoutMs }); return typeof result === 'function' ? result(args) : result; },
    classify: async (input) => { classified.push(input); return answer(input); },
    settings: parseSettings({ dispatch: settings }).dispatch,
    config: { orgTz: 'UTC', orgDispatchQuiet: null, orgDispatchDailyTokens: 0, orgDispatchParallel: 2, orgZenCommand: 'zen-agent', vaultRoot: vault, ...over },
    now: () => now,
    env: { PATH: '/usr/bin' },
  });
  return { d, vault, calls, classified, now, setAnswer: (f: typeof answer) => { answer = f; }, setResult: (r: typeof result) => { result = r; } };
}

const codexOrg = () => ({ ...ORG, agents: { ...ORG.agents,
  codebot: { role: 'Coder', team: 'platform', reports_to: 'atlas', runtime: 'codex', model: 'gpt-6-sol', capabilities: ['code'] },
} });
const codexJson = (text: string) => ({ code: 0, stderr: '', stdout: [
  JSON.stringify({ type: 'thread.started', thread_id: '01a1b593-4e59-79f3-b85f-00559646839a' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } }),
].join('\n') });
const codexFake = (state: 'done' | 'timeout' | 'cancelled' | 'error' = 'done') => (args: string[]): RunnerResult => {
  if (args[0] === 'login') return { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' };
  if (args.includes('--ephemeral')) return codexJson('READY');
  if (state === 'timeout') return { ...codexJson(''), code: 1, timedOut: true };
  if (state === 'cancelled') return { ...codexJson(''), code: 1, cancelled: true };
  if (state === 'error') return { code: 1, stdout: '{"type":"turn.failed"}', stderr: 'task failed' };
  return codexJson('Changed the file; tests pass');
};

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
  it('preflights, claims only a Codex card, records usage and moves success to review', async () => {
    await importOrg(codexOrg());
    const card = await createCard('owner', { title: 'Fix a file', body: 'Change one file', assignee: 'codebot', needs: 'code' });
    const h = harness();
    h.setResult(codexFake());
    const r = await h.d.tick();
    expect(r).toMatchObject({ agents: 1, runs: 1, errors: [] });
    expect(h.calls.map((c) => c.args[0])).toEqual(['login', 'exec', 'exec']);
    expect(h.calls[2]!.args).toContain('gpt-6-sol');
    expect((await getCard(card.id)).card.status).toBe('review');
    expect((await query(`SELECT runtime, outcome, usage->>'input_tokens' AS input FROM usage_runs WHERE agent_name = 'codebot'`)).rows)
      .toEqual([{ runtime: 'codex', outcome: 'did-work', input: '12' }]);
    expect((await query(`SELECT source, input_tokens FROM usage_calls WHERE source = 'codex'`)).rows)
      .toEqual([{ source: 'codex', input_tokens: 12 }]);
  });

  it('claims a card using an effective Codex runtime override', async () => {
    await setOverride('owner', 'bolt', { runtime: 'codex', model: 'gpt-6-sol' });
    const card = await createCard('owner', { title: 'Write a file', assignee: 'bolt' });
    const h = harness();
    h.setResult(codexFake());
    await h.d.tick();
    expect((await getCard(card.id)).card.status).toBe('review');
    expect((await query(`SELECT runtime FROM card_runs WHERE card_id = $1`, [card.id])).rows).toEqual([{ runtime: 'codex' }]);
  });

  it('relays a Codex answer to a same-team DM thread', async () => {
    await importOrg(codexOrg());
    await dm(await getAgent('atlas'), 'codebot', 'Can you check this?', {});
    const h = harness();
    h.setResult(codexFake());
    await h.d.tick();
    const { rows } = await query<{ author: string; body: string; kind: string }>(
      `SELECT author, body, kind FROM org_messages WHERE author = 'codebot' AND kind = 'reply' ORDER BY id`);
    expect(rows).toEqual([{ author: 'codebot', body: 'Changed the file; tests pass', kind: 'reply' }]);
  });

  it('blocks a Codex card visibly when subscription preflight fails', async () => {
    await importOrg(codexOrg());
    const card = await createCard('owner', { title: 'Fix a file', assignee: 'codebot', needs: 'code' });
    const h = harness();
    h.setResult(() => ({ code: 0, stdout: 'Logged in using API key', stderr: '' }));
    const r = await h.d.tick();
    expect(r.errors).toEqual([expect.stringMatching(/subscription login unavailable/)]);
    expect((await getCard(card.id)).card).toMatchObject({ status: 'blocked', block_kind: 'tool-error' });
    expect(await openWakeups('codebot')).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });

  it('refuses a repository card before launch so the isolated runner owns it', async () => {
    await importOrg(codexOrg());
    const card = await createCard('owner', { title: 'Change engine', assignee: 'codebot', needs: 'code', repo: 'engine' });
    const h = harness();
    h.setResult(codexFake());
    await h.d.tick();
    expect((await getCard(card.id)).card).toMatchObject({ status: 'blocked', block_kind: 'tool-error' });
    expect(h.calls.map((c) => c.args[0])).toEqual(['login', 'exec']);
  });

  it('blocks a claimed Codex card on timeout and finishes the wake', async () => {
    await importOrg(codexOrg());
    const card = await createCard('owner', { title: 'Fix a file', assignee: 'codebot', needs: 'code' });
    const h = harness();
    h.setResult(codexFake('timeout'));
    await h.d.tick();
    expect((await getCard(card.id)).card).toMatchObject({ status: 'blocked', block_kind: 'budget' });
    expect((await openWakeups('codebot'))).toEqual([]);
  });

  it('resumes the exact prior Codex session after a human retries a timed-out card', async () => {
    await importOrg(codexOrg());
    const card = await createCard('owner', { title: 'Fix a file', assignee: 'codebot', needs: 'code' });
    const h = harness();
    h.setResult(codexFake('timeout'));
    await h.d.tick();
    await moveCard('owner', card.id, 'ready', 'retry');
    h.setResult(codexFake());
    await h.d.tick();
    expect(h.calls.at(-1)!.args.slice(0, 3)).toEqual(['exec', 'resume', '01a1b593-4e59-79f3-b85f-00559646839a']);
    expect((await getCard(card.id)).card.status).toBe('review');
  });

  it('blocks a claimed Codex card on a failed turn', async () => {
    await importOrg(codexOrg());
    const card = await createCard('owner', { title: 'Fix a file', assignee: 'codebot', needs: 'code' });
    const h = harness();
    h.setResult(codexFake('error'));
    await h.d.tick();
    expect((await getCard(card.id)).card).toMatchObject({ status: 'blocked', block_kind: 'tool-error' });
  });

  it('blocks a claimed Codex card on cancellation and releases its run', async () => {
    await importOrg(codexOrg());
    const card = await createCard('owner', { title: 'Fix a file', assignee: 'codebot', needs: 'code' });
    const h = harness();
    h.setResult(codexFake('cancelled'));
    await h.d.tick();
    expect((await getCard(card.id)).card).toMatchObject({ status: 'blocked', block_kind: 'tool-error' });
    expect((await query(`SELECT outcome, finished_at FROM card_runs WHERE card_id = $1`, [card.id])).rows)
      .toEqual([{ outcome: 'partial', finished_at: expect.any(Date) }]);
  });
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

  it('a failed spawn writes one failed usage_runs row, and a successful run writes none', async () => {
    const h = harness();
    await dm(await getAgent('atlas'), 'rune', 'please check the build', {});
    h.setResult({ code: 1, stdout: '', stderr: 'zen-agent: no such persona' });
    await h.d.tick();
    const q = `SELECT run_id, agent_name, runtime, outcome, is_error, subtype, wakeup_ids::text[] AS wakeup_ids FROM usage_runs`;
    const { rows } = await query<{ run_id: string; agent_name: string; runtime: string; outcome: string; is_error: boolean; subtype: string; wakeup_ids: string[] }>(q);
    expect(rows).toEqual([{ run_id: 'rune-20261024-123000', agent_name: 'rune', runtime: 'zen-agent', outcome: 'failed', is_error: true,
      subtype: 'zen-agent: no such persona', wakeup_ids: [expect.any(String)] }]);
    // The before/after query in the PR body: finished-with-failure wakeups that have no usage row.
    const orphans = await query(`SELECT w.id FROM org_wakeups w WHERE w.done_at IS NOT NULL AND w.result ~ '^(zen-agent: |exit [0-9])'
      AND NOT EXISTS (SELECT 1 FROM usage_runs u WHERE w.id = ANY (u.wakeup_ids))`);
    expect(orphans.rows).toEqual([]);
    const ok = harness();
    await dm(await getAgent('atlas'), 'bolt', 'and this', {});
    await ok.d.tick();
    expect((await query(`SELECT 1 FROM usage_runs WHERE agent_name = 'bolt'`)).rows).toEqual([]);
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

describe('model routing (docs/org-routing.md)', () => {
  const cfg = {
    tiers: { t0: { turns: 8 }, t1: { turns: 20 }, t2: { turns: 30 }, t3: { turns: 40 } },
    floors: { coding_single_file_named_path: 't1', coding_default: 't2', high_risk: 't3', merge: 't3', deploy: 't3' },
    escalation: { turn_cap_no_commit: 1, tests_failed_twice: 1, review_changes_twice: 1 },
    risk_keywords: ['migration'],
    models: [
      { id: 'ollama/small', provider: 'ollama', tier: 't1', can_code: false, local: true },
      { id: 'openrouter/mid', provider: 'anthropic', tier: 't2', can_code: true, local: false, price_in: 2, price_out: 10 },
      { id: 'openrouter/top', provider: 'anthropic', tier: 't3', can_code: true, local: false, price_in: 4, price_out: 20 },
    ],
  } as const;
  const routed = (model: string) => ({ ...ORG, agents: { ...ORG.agents, rune: { ...ORG.agents.rune, model } } });
  const card = async (title = 'Fix the build', type = 'coding') => {
    await query(`INSERT INTO boards (slug, name) VALUES ('exo', 'Exo') ON CONFLICT DO NOTHING`);
    await query(`INSERT INTO cards (id, board_slug, title, assignee, created_by, work_type) VALUES ('t_abc123', 'exo', $1, 'rune', 'atlas', $2)`, [title, type]);
    await addWakeup('rune', 'task', 't_abc123');
  };
  const withRouter = (h: ReturnType<typeof harness>, mode: 'shadow' | 'on', maxTier?: 't1' | 't2' | 't3') => {
    (h.d as unknown as { deps: Deps }).deps.router = { mode, cfg: cfg as never, maxTier };
  };

  it('shadow mode logs the decision and changes nothing', async () => {
    await importOrg(routed('openrouter/mid'));
    const h = harness();
    withRouter(h, 'shadow');
    await card();
    await h.d.tick();
    expect(flag(h.calls[0]!.args, '--model')).toBe('openrouter/mid'); // the bot's own
    const { rows } = await query<{ action: string; model: string; result: string }>(
      `SELECT d.action, d.model, o.result FROM route_decisions d JOIN route_outcomes o ON o.decision_id = d.id WHERE d.card_id = 't_abc123'`);
    expect(rows).toEqual([{ action: 'run', model: 'openrouter/mid', result: 'done' }]);
  });

  it('on: a coder on a model below its floor is parked, not run', async () => {
    await importOrg(routed('ollama/small'));
    const h = harness();
    withRouter(h, 'on');
    await card();
    const r = await h.d.tick();
    expect(r.runs).toBe(0);
    expect(h.calls).toHaveLength(0);
    const { rows } = await query<{ result: string }>(`SELECT result FROM org_wakeups WHERE agent_name = 'rune'`);
    expect(rows[0]!.result).toMatch(/^routed park: floor t2/);
  });

  it('on: runs the routed model with the tier budget, and a budget stop escalates the next run when maxTier allows', async () => {
    await importOrg(routed('openrouter/mid'));
    const h = harness();
    withRouter(h, 'on', 't3');
    await card();
    h.setResult({ code: 3, stdout: JSON.stringify({ text: 'out of turns', stopped: 'budget' }), stderr: '' });
    await h.d.tick();
    expect(flag(h.calls[0]!.args, '--model')).toBe('openrouter/mid');
    expect(flag(h.calls[0]!.args, '--max-turns')).toBe('30');
    await query(`INSERT INTO org_wakeups (agent_name, reason, ref) VALUES ('rune', 'task', 't_abc123')`); // a re-wake of the same card
    await h.d.tick();
    expect(flag(h.calls[1]!.args, '--model')).toBe('openrouter/top');
    expect(flag(h.calls[1]!.args, '--max-turns')).toBe('40');
    expect(meta(h.calls[1]!.args, 'tier')).toBe('t3');
  });
  it('feeds the card classifier into the decision: a two-repo card with no spec is asked for one, and the signals are logged', async () => {
    await importOrg(routed('openrouter/mid'));
    const h = harness();
    withRouter(h, 'on', 't3');
    await card();
    await query(`UPDATE cards SET body = 'Update github.com/acme/sdk and github.com/acme/app to match' WHERE id = 't_abc123'`);
    const r = await h.d.tick();
    expect(r.runs).toBe(0);
    const { rows } = await query<{ action: string; signals: { scope: number; specClarity: string; classified: { repos: number; source: string } } }>(
      `SELECT action, signals FROM route_decisions WHERE card_id = 't_abc123'`);
    expect(rows).toEqual([{ action: 'ask-spec', signals: expect.objectContaining({ scope: 2, specClarity: 'low', classified: expect.objectContaining({ repos: 2, source: 'rules' }) }) }]);
  });

  it('a risk flag in the card body raises the floor to the top tier', async () => {
    await importOrg(routed('openrouter/mid'));
    const h = harness();
    withRouter(h, 'on', 't3');
    await card();
    await query(`UPDATE cards SET body = 'Edit server/src/a.ts, then deploy to production' WHERE id = 't_abc123'`);
    await h.d.tick();
    expect(flag(h.calls[0]!.args, '--model')).toBe('openrouter/top');
  });
});

describe('fallback model (docs/org-routing.md, "Fallback model")', () => {
  const m1 = { name: 'box1', url: 'http://box1:11434' };
  const cfg = {
    tiers: { t0: { turns: 8 }, t1: { turns: 20 }, t2: { turns: 30 }, t3: { turns: 40 } },
    floors: { coding_single_file_named_path: 't1', coding_default: 't2', high_risk: 't3', merge: 't3', deploy: 't3' },
    escalation: { turn_cap_no_commit: 1, tests_failed_twice: 1, review_changes_twice: 1 },
    risk_keywords: [],
    models: [{ id: 'ollama-box1/qwen', aliases: ['qwen'], provider: 'ollama-box1', tier: 't1', can_code: false, local: true }],
  } as const;
  const onModel = (model: string) => ({ ...ORG, agents: { ...ORG.agents, rune: { ...ORG.agents.rune, model } } });
  const settings = { fallback: { model: 'together/deepseek-ai/DeepSeek-V4.1-Flash' } };
  const probed: string[] = [];
  const withProbe = (h: ReturnType<typeof harness>, up: boolean) => {
    (h.d as unknown as { deps: Deps }).deps.probe = async (m) => { probed.push(m.name); return up; };
  };
  const card = async () => {
    await query(`INSERT INTO boards (slug, name) VALUES ('exo', 'Exo') ON CONFLICT DO NOTHING`);
    await query(`INSERT INTO cards (id, board_slug, title, assignee, created_by, work_type) VALUES ('t_abc123', 'exo', 'Summarise the thread', 'rune', 'atlas', 'ops')`);
    await addWakeup('rune', 'task', 't_abc123');
  };
  const wakeResult = async (): Promise<string> =>
    (await query<{ result: string }>(`SELECT result FROM org_wakeups WHERE agent_name = 'rune'`)).rows[0]!.result;
  beforeEach(() => { probed.length = 0; });

  it('pure helpers: provider by prefix or catalog alias, machine by provider, provider errors by their words', () => {
    expect(providerOf('together/deepseek-ai/x')).toBe('together');
    expect(providerOf('qwen', cfg as never)).toBe('ollama-box1');
    expect(providerOf('qwen')).toBeNull();
    expect(providerOf(null)).toBeNull();
    expect(machineOf('ollama-box1', [m1])).toEqual(m1);
    expect(machineOf('ollama-other', [m1])).toBeNull();
    expect(machineOf('together', [m1])).toBeNull();
    expect(isProviderError("model qwen is not in provider ollama-box1's catalogue")).toBe(true);
    expect(isProviderError('fetch failed: connect ECONNREFUSED 192.0.2.2:11434')).toBe(true);
    expect(isProviderError('502 Bad Gateway')).toBe(true);
    expect(isProviderError('tests failed: 2 of 14')).toBe(false);
    expect(isProviderError('BLOCKED: the card names no file')).toBe(false);
  });

  it('machine down: the fallback model runs instead, the trace and the wakeup say so', async () => {
    await importOrg(onModel('ollama-box1/qwen'));
    const h = harness({ machines: [m1] }, settings);
    withProbe(h, false);
    await card();
    await h.d.tick();
    expect(probed).toEqual(['box1']);
    expect(h.calls).toHaveLength(1);
    expect(flag(h.calls[0]!.args, '--model')).toBe('together/deepseek-ai/DeepSeek-V4.1-Flash');
    expect(meta(h.calls[0]!.args, 'fallback')).toBe('machine-down');
    expect(await wakeResult()).toMatch(/^\[fallback machine-down: together\/deepseek-ai\/DeepSeek-V4\.1-Flash\] posted a status/);
  });

  it('machine up: the bot runs on its own model and nothing is retried', async () => {
    await importOrg(onModel('ollama-box1/qwen'));
    const h = harness({ machines: [m1] }, settings);
    withProbe(h, true);
    await card();
    await h.d.tick();
    expect(probed).toEqual(['box1']);
    expect(h.calls).toHaveLength(1);
    expect(flag(h.calls[0]!.args, '--model')).toBe('ollama-box1/qwen');
    expect(meta(h.calls[0]!.args, 'fallback')).toBeUndefined();
  });

  it('a hosted model is never probed; without the setting a machine model is not probed either', async () => {
    await importOrg(onModel('openrouter/deepseek/deepseek-v4.1-flash'));
    const h = harness({ machines: [m1] }, settings);
    withProbe(h, false);
    await card();
    await h.d.tick();
    expect(probed).toEqual([]);
    expect(flag(h.calls[0]!.args, '--model')).toBe('openrouter/deepseek/deepseek-v4.1-flash');

    await truncateAll();
    await importOrg(onModel('ollama-box1/qwen'));
    const h2 = harness({ machines: [m1] });
    withProbe(h2, false);
    await card();
    await h2.d.tick();
    expect(probed).toEqual([]);
    expect(flag(h2.calls[0]!.args, '--model')).toBe('ollama-box1/qwen');
  });

  it('run died on the machine: one re-run on the fallback under <run>-fb, the first run recorded as failed', async () => {
    await importOrg(onModel('ollama-box1/qwen'));
    const h = harness({ machines: [m1] }, settings);
    withProbe(h, true);
    await card();
    let first = true;
    const ok = { code: 0, stdout: JSON.stringify({ text: 'done on the fallback', stopped: 'done', turns: 2 }) + '\n', stderr: '' };
    (h.d as unknown as { deps: Deps }).deps.runner = async (cmd, args, env, cwd, timeoutMs) => {
      h.calls.push({ cmd, args, env, cwd, timeoutMs });
      if (first) { first = false; return { code: 1, stdout: '', stderr: "zen-agent: model qwen is not in provider ollama-box1's catalogue\n" }; }
      return ok;
    };
    await h.d.tick();
    expect(h.calls).toHaveLength(2);
    expect(flag(h.calls[0]!.args, '--model')).toBe('ollama-box1/qwen');
    expect(flag(h.calls[1]!.args, '--model')).toBe('together/deepseek-ai/DeepSeek-V4.1-Flash');
    expect(meta(h.calls[1]!.args, 'fallback')).toBe('run-error');
    expect(meta(h.calls[1]!.args, 'run_id')).toBe(`${meta(h.calls[0]!.args, 'run_id')}-fb`);
    expect(h.calls[1]!.env['ORG_RUN']).toBe(meta(h.calls[1]!.args, 'run_id'));
    expect(await wakeResult()).toMatch(/^\[fallback run-error: together\/deepseek-ai\/DeepSeek-V4\.1-Flash\] done on the fallback/);
    const { rows } = await query<{ subtype: string | null; is_error: boolean }>(`SELECT subtype, is_error FROM usage_runs WHERE run_id = $1`, [meta(h.calls[0]!.args, 'run_id')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_error).toBe(true);
    expect(rows[0]!.subtype).toMatch(/^provider error on box1: /);
  });

  it('a task failure or a budget stop on the machine is not retried', async () => {
    await importOrg(onModel('ollama-box1/qwen'));
    const h = harness({ machines: [m1] }, settings);
    withProbe(h, true);
    await card();
    h.setResult({ code: 1, stdout: JSON.stringify({ text: 'BLOCKED: tests failed twice', stopped: 'error' }) + '\n', stderr: '' });
    await h.d.tick();
    expect(h.calls).toHaveLength(1);
    expect(await wakeResult()).toBe('BLOCKED: tests failed twice');

    await truncateAll();
    await importOrg(onModel('ollama-box1/qwen'));
    const h2 = harness({ machines: [m1] }, settings);
    withProbe(h2, true);
    await card();
    h2.setResult({ code: 3, stdout: JSON.stringify({ text: 'out of turns: connection reset mid-run', stopped: 'budget' }) + '\n', stderr: '' });
    await h2.d.tick();
    expect(h2.calls).toHaveLength(1);
  });

  it('with the router on, the routed machine model falls back and keeps the tier budget', async () => {
    await importOrg(onModel('ollama-box1/qwen'));
    const h = harness({ machines: [m1] }, settings);
    (h.d as unknown as { deps: Deps }).deps.router = { mode: 'on', cfg: cfg as never };
    withProbe(h, false);
    await card();
    await h.d.tick();
    expect(h.calls).toHaveLength(1);
    expect(flag(h.calls[0]!.args, '--model')).toBe('together/deepseek-ai/DeepSeek-V4.1-Flash');
    expect(flag(h.calls[0]!.args, '--max-turns')).toBe('20'); // the tier's budget, not the fallback's
    expect(meta(h.calls[0]!.args, 'tier')).toBe('t1');
  });
});
