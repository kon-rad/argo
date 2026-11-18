import { beforeEach, describe, expect, it } from 'vitest';
import { claimCard, createCard, finishCard } from '../src/board.js';
import { breakerDecisions, claudeRateLimitStreak, runBreaker, type BreakerLimits } from '../src/breaker.js';
import { query } from '../src/db.js';
import { importOrg } from '../src/org.js';
import { truncateAll } from './helpers.js';

/**
 * The credit breaker (cutover plan 5a, item 3). Thresholds here are the ones proposed in the PR, not guesses
 * baked into behaviour: they arrive as BreakerLimits, so a different number is an env change.
 */

const LIMITS: BreakerLimits = { openrouterMinBalance: 5, openrouterMaxAgeMinutes: 180, claudeRateLimitStreak: 2 };

describe('breakerDecisions (pure)', () => {
  it('pauses the zen-agent lane when the OpenRouter balance is under the minimum', () => {
    const d = breakerDecisions({ openrouterBalance: 4.2, openrouterAgeMinutes: 10, claudeStreak: 0 }, LIMITS);
    expect(d).toEqual([{ runtime: 'zen-agent', reason: expect.stringContaining('openrouter balance $4.20 is under $5.00') }]);
  });

  it('does nothing at or above the minimum', () => {
    expect(breakerDecisions({ openrouterBalance: 5, openrouterAgeMinutes: 10, claudeStreak: 0 }, LIMITS)).toEqual([]);
  });

  it('never pauses on an unknown or stale balance: a broken credits-sync must not stop the company', () => {
    expect(breakerDecisions({ openrouterBalance: null, openrouterAgeMinutes: null, claudeStreak: 0 }, LIMITS)).toEqual([]);
    expect(breakerDecisions({ openrouterBalance: 0.1, openrouterAgeMinutes: 600, claudeStreak: 0 }, LIMITS)).toEqual([]);
  });

  it('pauses the claude-code lane on two rate-limit errors in a row, not on one', () => {
    expect(breakerDecisions({ openrouterBalance: 50, openrouterAgeMinutes: 1, claudeStreak: 1 }, LIMITS)).toEqual([]);
    const d = breakerDecisions({ openrouterBalance: 50, openrouterAgeMinutes: 1, claudeStreak: 2 }, LIMITS);
    expect(d).toEqual([{ runtime: 'claude-code', reason: expect.stringContaining('2 rate-limit errors in a row') }]);
  });
});

const ORG = {
  version: 'breaker-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner', model: 'opus' },
    quill: { role: 'Writer', team: 'platform', reports_to: 'atlas', model: 'sonnet' },
    rune: { runtime: 'zen-agent', role: 'Platform engineer', team: 'platform', reports_to: 'atlas', model: 'openrouter/deepseek/deepseek-v4.1-flash' },
    sol: { role: 'Chief of staff', team: 'staff', reports_to: 'owner', capabilities: ['dispatch'] },
  },
  teams: { platform: { name: 'Platform', lead: 'atlas' }, staff: { name: 'Staff', lead: 'sol' } },
  channels: { 'all-hands': { members: '*' }, leads: { members: ['owner', 'atlas', 'sol'] } },
};

async function blockedRun(title: string, reason: string): Promise<void> {
  const c = await createCard('owner', { title, assignee: 'quill' });
  await claimCard(null, { agent: 'quill' });
  await finishCard('quill', c.id, { outcome: 'blocked', result: reason, blockKind: 'tool-error' });
}

async function doneRun(title: string): Promise<void> {
  const c = await createCard('owner', { title, assignee: 'quill' });
  await claimCard(null, { agent: 'quill' });
  await finishCard('quill', c.id, { outcome: 'done', result: 'ok' });
}

describe('claudeRateLimitStreak and runBreaker', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
  });

  it('counts only the unbroken tail of rate-limited claude-code runs', async () => {
    await blockedRun('old', 'weekly limit reached');
    await doneRun('recovered');
    expect(await claudeRateLimitStreak(5)).toBe(0);
    await blockedRun('one', 'Claude usage limit reached, resets 4pm');
    expect(await claudeRateLimitStreak(5)).toBe(1);
    await blockedRun('two', '429 rate limit exceeded');
    expect(await claudeRateLimitStreak(5)).toBe(2);
  });

  it('a block for some other reason is not a rate limit and breaks the streak', async () => {
    await blockedRun('one', 'rate limit hit');
    await blockedRun('other', 'needs input from konrad');
    expect(await claudeRateLimitStreak(5)).toBe(0);
  });

  it('runBreaker pauses the claude lane after two in a row, says so once, and leaves zen-agent alone', async () => {
    await blockedRun('one', 'usage limit');
    await blockedRun('two', 'usage limit');
    const first = await runBreaker('sol', LIMITS, { dryRun: false });
    expect(first.map((a) => [a.runtime, a.paused])).toEqual([['claude-code', 3]]); // atlas, quill, sol
    const second = await runBreaker('sol', LIMITS, { dryRun: false });
    expect(second.map((a) => a.paused)).toEqual([0]);
    const lines = await query<{ body: string }>(`SELECT body FROM org_messages WHERE channel_slug = 'platform' AND body LIKE 'paused: lane claude-code%'`);
    expect(lines.rows).toHaveLength(1);
    const rune = await query<{ paused: boolean }>(`SELECT paused FROM org_agents WHERE name = 'rune'`);
    expect(rune.rows[0]!.paused).toBe(false);
  });

  it('dry run reports what it would pause and pauses nothing', async () => {
    await blockedRun('one', 'usage limit');
    await blockedRun('two', 'usage limit');
    const r = await runBreaker('sol', LIMITS, { dryRun: true });
    expect(r).toHaveLength(1);
    expect((await query(`SELECT 1 FROM org_agents WHERE paused`)).rows).toHaveLength(0);
  });

  it('pauses the zen-agent lane from the stored OpenRouter balance', async () => {
    await query(`INSERT INTO provider_credit_snapshots (provider, origin, status, observed_at, balance) VALUES ('openrouter', 'api', 'ok', now(), 3.5)`);
    const r = await runBreaker('sol', LIMITS, { dryRun: false });
    expect(r.map((a) => [a.runtime, a.paused])).toEqual([['zen-agent', 1]]);
  });
});
