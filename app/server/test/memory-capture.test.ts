import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { importOrg } from '../src/org.js';
import { capturePrompt, parseFacts, runCapture, selectWakes, wakeText, type CaptureConfig, type EpisodeRow } from '../src/memory-capture.js';
import { parseSettings } from '../src/settings.js';
import { truncateAll } from './helpers.js';

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

function cfg(over: Record<string, unknown> = {}): CaptureConfig {
  return parseSettings({ memory: { capture: { enabled: true, ...over } } }).memory.capture;
}

async function episode(
  agent: string,
  run: string,
  over: { outcome?: string; turns?: number; summary?: string; ageHours?: number } = {},
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO org_agent_episodes (agent_name, run_id, reason, outcome, turn_count, summary, created_at)
     VALUES ($1,$2,'task',$3,$4,$5, now() - make_interval(hours => $6)) RETURNING id`,
    [agent, run, over.outcome ?? 'done', over.turns ?? 8, over.summary ?? 'Worked card t_1. Finished. Did the thing.', over.ageHours ?? 0],
  );
  return rows[0]!.id;
}

const factLines = async (agent: string | null) => {
  const { rows } = await query<{ subject: string; claim: string; source: string; author: string; via: string; confidence: string }>(
    `SELECT subject, claim, source, author, via, confidence FROM memory_facts WHERE agent IS NOT DISTINCT FROM $1 ORDER BY id`,
    [agent],
  );
  return rows;
};

beforeEach(async () => {
  await truncateAll();
  await importOrg(ORG);
});

describe('parseFacts', () => {
  it('reads a plain JSON answer', () => {
    expect(parseFacts('{"facts":[{"subject":"S","claim":"C","source":"episode:1"}]}')).toEqual([{ subject: 'S', claim: 'C', source: 'episode:1' }]);
  });

  it('ignores thinking blocks and code fences around the object', () => {
    const raw = 'Sure.\n```json\n{"facts":[{"subject":"S","claim":"C"}]}\n```';
    expect(parseFacts(raw)).toEqual([{ subject: 'S', claim: 'C', source: '' }]);
    expect(parseFacts(' thinkinghmm</think>{"facts":[]}')).toEqual([]);
  });

  it('returns null when the answer does not parse, and an empty list for a malformed fact', () => {
    expect(parseFacts('no json here')).toBeNull();
    expect(parseFacts('{"facts":[{"subject":""}]}')).toEqual([]);
    expect(parseFacts('{"other":1}')).toEqual([]);
  });
});

describe('capturePrompt', () => {
  it('falls back to the engine default template', () => {
    expect(capturePrompt(cfg()).length).toBeGreaterThan(200);
  });

  it('an inline systemPrompt wins over everything', () => {
    expect(capturePrompt(cfg({ systemPrompt: 'CUSTOM PROMPT' }))).toBe('CUSTOM PROMPT');
  });

  it('throws when a named prompt file does not exist', () => {
    expect(() => capturePrompt(cfg({ promptFile: 'definitely/missing-prompt.md' }))).toThrow(/prompt file not found/);
  });
});

describe('wakeText', () => {
  it('carries the outcome, the card and the summary', () => {
    const e = { id: 7, agent_name: 'rune', run_id: 'r1', task_id: 't_abc', reason: 'task', outcome: 'done', corrected: false, turn_count: 8, cost_usd: '0.10', duration_s: 30, summary: 'Did the thing.', log_path: '/x.log', created_at: new Date() } as EpisodeRow;
    const t = wakeText(e);
    expect(t).toContain('Wake 7 of rune');
    expect(t).toContain('Card: t_abc.');
    expect(t).toContain('Did the thing.');
  });
});

describe('selectWakes', () => {
  it('admits only the wakes the policy admits: outcome, turns, age and agent', async () => {
    await episode('rune', 'r-done', { turns: 8 });
    await episode('rune', 'r-short', { turns: 1 });
    await episode('rune', 'r-noreport', { outcome: 'no_report', turns: 8 });
    await episode('rune', 'r-old', { turns: 8, ageHours: 48 });
    await episode('bolt', 'b-done', { turns: 8 });

    const all = await selectWakes(cfg(), {});
    expect(all.map((e) => e.run_id).sort()).toEqual(['b-done', 'r-done']);
    expect((await selectWakes(cfg(), { agent: 'rune' })).map((e) => e.run_id)).toEqual(['r-done']);
    expect((await selectWakes(cfg(), { all: true })).map((e) => e.run_id).sort()).toEqual(['b-done', 'r-done', 'r-old']);

    // An already-captured wake is never read again.
    await query(`UPDATE org_agent_episodes SET reflected_at = now() WHERE run_id = 'r-done'`);
    expect((await selectWakes(cfg(), {})).map((e) => e.run_id)).toEqual(['b-done']);
  });
});

describe('runCapture', () => {
  const answerOf = (facts: { subject: string; claim: string; source?: string }[], model = 'fake/model') => async () => ({ facts: facts.map((f) => ({ source: '', ...f })), model });

  it('writes the model facts as the bot\'s own memory and stamps the episode', async () => {
    const id = await episode('rune', 'r1');
    const r = await runCapture({ cfg: cfg(), answer: answerOf([{ subject: 'Board exo', claim: 'The board lives in Postgres on the droplet.', source: 'episode:1' }]) });
    expect(r).toMatchObject({ considered: 1, processed: 1, facts: 1, skipped: 0, failed: 0 });
    expect(r.agents).toEqual(['rune']);
    expect(await factLines('rune')).toEqual([{ subject: 'Board exo', claim: 'The board lives in Postgres on the droplet.', source: 'episode:1', author: 'rune', via: 'memory-capture', confidence: 'inferred' }]);
    const { rows } = await query<{ reflected_at: Date | null; reflect_model: string | null }>(`SELECT reflected_at, reflect_model FROM org_agent_episodes WHERE id = $1`, [id]);
    expect(rows[0]!.reflected_at).not.toBeNull();
    expect(rows[0]!.reflect_model).toBe('fake/model');
  });

  it('scope company writes the same fact untagged', async () => {
    await episode('rune', 'r1');
    await runCapture({ cfg: cfg({ scope: 'company' }), answer: answerOf([{ subject: 'S', claim: 'A company-wide claim.' }]) });
    expect(await factLines(null)).toHaveLength(1);
    expect(await factLines('rune')).toHaveLength(0);
  });

  it('caps the facts per wake, and skips a claim the bot already holds', async () => {
    await episode('rune', 'r1');
    const ans = answerOf([{ subject: 'A', claim: 'First claim.' }, { subject: 'B', claim: 'Second claim.' }, { subject: 'C', claim: 'Third claim.' }]);
    const first = await runCapture({ cfg: cfg({ maxFactsPerWake: 2 }), answer: ans });
    expect(first).toMatchObject({ facts: 2, skipped: 0 });
    expect(await factLines('rune')).toHaveLength(2);

    await episode('rune', 'r2');
    const second = await runCapture({ cfg: cfg(), force: true, answer: answerOf([{ subject: 'A', claim: 'First claim.' }]) });
    expect(second).toMatchObject({ facts: 0, skipped: 1 });
    expect(await factLines('rune')).toHaveLength(2);
  });

  it('a wake that yields nothing is still stamped, so it is not re-asked', async () => {
    const id = await episode('rune', 'r1');
    const r = await runCapture({ cfg: cfg(), answer: answerOf([]) });
    expect(r).toMatchObject({ processed: 1, facts: 0 });
    const { rows } = await query(`SELECT reflected_at FROM org_agent_episodes WHERE id = $1`, [id]);
    expect((rows[0] as { reflected_at: Date | null }).reflected_at).not.toBeNull();
  });

  it('dry-run asks and reports but writes nothing', async () => {
    await episode('rune', 'r1');
    const r = await runCapture({ cfg: cfg(), dryRun: true, answer: answerOf([{ subject: 'S', claim: 'Would write.' }]) });
    expect(r).toMatchObject({ considered: 1, processed: 1, facts: 1 });
    expect(await factLines('rune')).toHaveLength(0);
    const { rows } = await query(`SELECT count(*)::int AS n FROM org_agent_episodes WHERE reflected_at IS NOT NULL`);
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('counts a failed wake and leaves it un-stamped for the next tick', async () => {
    const id = await episode('rune', 'r1');
    const r = await runCapture({ cfg: cfg(), answer: async () => { throw new Error('no provider answered'); } });
    expect(r).toMatchObject({ considered: 1, processed: 0, failed: 1 });
    const { rows } = await query(`SELECT reflected_at FROM org_agent_episodes WHERE id = $1`, [id]);
    expect((rows[0] as { reflected_at: Date | null }).reflected_at).toBeNull();
  });

  it('does nothing when the loop is off', async () => {
    await episode('rune', 'r1');
    const r = await runCapture({ cfg: cfg({ enabled: false }), answer: answerOf([{ subject: 'S', claim: 'C' }]) });
    expect(r).toMatchObject({ considered: 0, facts: 0 });
  });

  it('respects the cadence gate (everyMinutes) unless forced', async () => {
    await episode('rune', 'r1');
    await runCapture({ cfg: cfg({ everyMinutes: 600 }), force: true, answer: answerOf([{ subject: 'S', claim: 'One.' }]) });
    await episode('rune', 'r2');
    const gated = await runCapture({ cfg: cfg({ everyMinutes: 600 }), answer: answerOf([{ subject: 'S', claim: 'Two.' }]) });
    expect(gated).toMatchObject({ considered: 0, facts: 0 });
    const forced = await runCapture({ cfg: cfg({ everyMinutes: 600 }), force: true, answer: answerOf([{ subject: 'S', claim: 'Two.' }]) });
    expect(forced).toMatchObject({ considered: 1, facts: 1 });
  });
});
