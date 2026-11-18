import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { addWakeup, dm, finishWakeups, getAgent, importOrg, openWakeups, post, routineRanToday } from '../src/org.js';
import { truncateAll } from './helpers.js';

// The zen-runtime migration: a third bot runtime, roster routines, the `ack` kind that wakes nobody,
// and one routine wakeup per local day (docs/zen-runtime.md, sections 4.1 and 8).
const ORG = {
  version: 'zen-1',
  company: 'Test Co',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner' },
    rune: {
      role: 'Platform engineer', team: 'platform', reports_to: 'atlas', runtime: 'zen-agent',
      routines: [{ name: 'standup', at: '06:30', days: [1, 2, 3, 4, 5], task_file: 'routines/standup.md' }],
    },
  },
  teams: { platform: { name: 'Platform', lead: 'atlas' } },
  channels: { 'all-hands': { members: '*', purpose: 'company-wide' } },
};

beforeEach(async () => {
  await truncateAll();
  await importOrg(ORG);
});

describe('zen-agent on the roster', () => {
  it('imports runtime zen-agent and the routines', async () => {
    expect((await getAgent('rune')).runtime).toBe('zen-agent');
    const { rows } = await query<{ routines: unknown }>(`SELECT routines FROM org_agents WHERE name = 'rune'`);
    expect(rows[0]!.routines).toEqual([{ name: 'standup', at: '06:30', days: [1, 2, 3, 4, 5], task_file: 'routines/standup.md' }]);
    expect((await query<{ routines: unknown[] }>(`SELECT routines FROM org_agents WHERE name = 'atlas'`)).rows[0]!.routines).toEqual([]);
  });

  it('rejects a routine with a bad time', async () => {
    await expect(importOrg({ ...ORG, agents: { ...ORG.agents, rune: { ...ORG.agents.rune, routines: [{ name: 'x', at: '25:00', task_file: 'f.md' }] } } }))
      .rejects.toThrow();
  });
});

describe('ack wakes nobody', () => {
  it('a DM of kind ack creates no wakeup, a plain DM does', async () => {
    const atlas = await getAgent('atlas');
    const rune = await getAgent('rune');
    await dm(atlas, 'rune', 'please look at the build', {});
    expect((await openWakeups('rune')).map((w) => w.reason)).toEqual(['dm']);
    await dm(rune, 'atlas', 'got it, nothing for me', { kind: 'ack' });
    expect(await openWakeups('atlas')).toEqual([]);
  });

  it('a channel post of kind ack with a mention creates no wakeup', async () => {
    const atlas = await getAgent('atlas');
    const m = await post(atlas, 'all-hands', '@rune noted', { kind: 'ack' });
    expect(m.kind).toBe('ack');
    expect(m.mentions).toEqual(['rune']);
    expect(await openWakeups('rune')).toEqual([]);
  });
});

describe('one routine per local day', () => {
  it('the second routine wakeup of the day is refused, even after the first finished', async () => {
    const id = await addWakeup('rune', 'routine', 'standup');
    expect(id).not.toBeNull();
    await finishWakeups([id!], { result: 'posted' });
    expect(await addWakeup('rune', 'routine', 'standup')).toBeNull();
    // Another routine, or another agent, is not blocked by it.
    expect(await addWakeup('rune', 'routine', 'brief')).not.toBeNull();
    expect(await addWakeup('atlas', 'routine', 'standup')).not.toBeNull();
  });

  it('judges "today" in the configured zone and forgets yesterday', async () => {
    const id = await addWakeup('rune', 'routine', 'standup');
    expect(await routineRanToday('rune', 'standup', 'UTC')).toBe(true);
    await query(`UPDATE org_wakeups SET created_at = now() - interval '2 days' WHERE id = $1`, [id]);
    expect(await routineRanToday('rune', 'standup', 'UTC')).toBe(false);
    expect(await addWakeup('rune', 'routine', 'standup')).toBeNull(); // still open: the dedupe index, not the day rule
    await finishWakeups([id!], {});
    expect(await addWakeup('rune', 'routine', 'standup')).not.toBeNull();
  });
});
