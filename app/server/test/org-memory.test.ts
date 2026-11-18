import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli-org.js';
import { query } from '../src/db.js';
import { claimWakeups, createTask, getAgent, importOrg } from '../src/org.js';
import { deriveOutcome, episodeSummary, listEpisodes, markCorrected, memoryStats, recordEpisode } from '../src/org-memory.js';
import { truncateAll } from './helpers.js';

/**
 * Agent episodes (docs/memory.md): one row per finished wake, written mechanically by `cli-org wake-done` with no
 * model call. This is what is left of the persona memory (docs/agent-memory.md) after engine core v2 phase 6 retired
 * the semantic store: a bot's durable claims are `memory_facts` tagged with its name now, read with
 * `secondbrain memory`.
 */

const ORG = {
  version: 'memory-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner', capabilities: ['review', 'merge'] },
    rune: { role: 'Platform engineer', team: 'platform', reports_to: 'atlas', capabilities: ['code'] },
    vera: { role: 'Reviewer', team: 'platform', reports_to: 'atlas', capabilities: ['review'] },
  },
  teams: { platform: { name: 'Platform', lead: 'atlas' } },
  channels: { 'all-hands': { members: '*' }, leads: { members: ['owner', 'atlas'] } },
};

describe('agent episodes', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
  });

  it('derives the outcome and writes a mechanical first-person summary', () => {
    expect(deriveOutcome({ exit: 1 })).toBe('error');
    expect(deriveOutcome({ exit: 0, result: 'blocked: waiting on the owner' })).toBe('blocked');
    expect(deriveOutcome({ result: 'changes requested by vera' })).toBe('request_changes');
    expect(deriveOutcome({ noReport: true })).toBe('no_report');
    expect(deriveOutcome({ outcome: 'done', exit: 2 })).toBe('done');
    expect(episodeSummary({ task: 't_000001', outcome: 'done', result: 'status: PR 12 opened\nmore' })).toBe('Worked card t_000001. Finished. status: PR 12 opened');
    expect(episodeSummary({ reason: 'chat', outcome: 'error' })).toBe('Worked a chat. Ended in an error.');
  });

  it('records one episode per run, idempotently', async () => {
    const rune = await getAgent('rune');
    const a = await recordEpisode(rune, { run: 'r-1', task: 't_abc123', turns: 4, cost: 0.12, result: 'done' });
    const b = await recordEpisode(rune, { run: 'r-1', task: 't_abc123', turns: 9 });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.episode.id).toBe(a.episode.id);
    expect(a.episode).toMatchObject({ reason: 'task', outcome: 'done', turn_count: 4, cost_usd: '0.1200', summary: 'Worked card t_abc123. Finished. done' });
    // An unknown reason is refused, and the run id is required.
    await expect(recordEpisode(rune, { run: 'r-2', reason: 'nonsense' })).rejects.toThrow(/episode reason is one of/);
    await expect(recordEpisode(rune, { run: '  ' })).rejects.toThrow(/needs its run id/);
  });

  it('wake-done records the episode, with the card from the wakeup', async () => {
    const card = (await createTask(await getAgent('owner'), { assignee: 'rune', title: 'Build the thing' })).task_id;
    const ws = await claimWakeups('rune', 'run-9');
    expect(ws).toHaveLength(1);
    const out: string[] = [];
    expect(await main(['wake-done', String(ws[0]!.id), '--run', 'run-9', '--exit', '0', '--result', 'status: built', '--turns', '7', '--cost', '0.3', '--duration', '120'], (s) => out.push(s))).toBe(0);
    expect(out.join('\n')).toMatch(/done 1 wakeup/);
    // The run left no status post, so wake-done posted the fallback and the episode says so.
    expect(out.join('\n')).toMatch(/episode #\d+ recorded \(no_report, 7 turns\)/);
    const { rows } = await query<{ task_id: string; wakeup_ids: number[]; reason: string; duration_s: number }>(`SELECT task_id, wakeup_ids, reason, duration_s FROM org_agent_episodes WHERE run_id = 'run-9'`);
    expect(rows[0]).toMatchObject({ task_id: card, wakeup_ids: [String(ws[0]!.id)], reason: 'task', duration_s: 120 });
  });

  it('lists episodes newest first and marks the latest on a card corrected', async () => {
    const rune = await getAgent('rune');
    await recordEpisode(rune, { run: 'e1', task: 't_aaa111', outcome: 'done', turns: 3, cost: 0.1 });
    await recordEpisode(rune, { run: 'e2', task: 't_bbb222', outcome: 'done', turns: 5, cost: 0.2 });
    const es = await listEpisodes('rune');
    expect(es.map((e) => e.run_id)).toEqual(['e2', 'e1']);
    expect(await markCorrected('rune', 't_bbb222')).toBe(true);
    expect(await markCorrected('rune', 't_nope')).toBe(false);
    expect((await listEpisodes('rune')).find((e) => e.run_id === 'e2')!.corrected).toBe(true);
  });

  it('stats: corrections and cost per completed card, from the episodes', async () => {
    const rune = await getAgent('rune');
    await recordEpisode(rune, { run: 'c1', task: 't_c00001', outcome: 'done', cost: 0.5, turns: 10 });
    await recordEpisode(rune, { run: 'c2', task: 't_c00002', outcome: 'done', cost: 1.5, turns: 20 });
    await recordEpisode(rune, { run: 'c3', task: 't_c00003', outcome: 'blocked', cost: 9, turns: 30 });
    await markCorrected('rune', 't_c00002');
    expect(await memoryStats('rune')).toMatchObject({ episodes: 3, done: 2, corrected: 1, corrections_per_done: 0.5, cost_per_done: 1, avg_turns: 20 });
    expect((await memoryStats('vera')).corrections_per_done).toBeNull();
  });
});
