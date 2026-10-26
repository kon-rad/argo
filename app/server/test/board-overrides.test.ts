import { beforeEach, describe, expect, it } from 'vitest';
import { claimCard, clearOverride, createCard, getCard, listOverrides, pauseAgents, pauseLane, resumeAgents, setOverride } from '../src/board.js';
import { query } from '../src/db.js';
import { importOrg, orgChart } from '../src/org.js';
import { truncateAll } from './helpers.js';

/**
 * The override table (cutover plan 5a, item 4): the owner switches a bot's runtime, model or effort with one row,
 * and the claim path reads override ?? roster, so the switch needs no commit and no deploy. The last two cases are
 * the phase 1b exit check: `pause all` leaves every ready card unclaimed and `resume` releases them; a test agent
 * moved from sonnet to a zen-agent provider/model is claimed by the zen-agent lane and no longer by claude-code.
 */

const ORG = {
  version: 'board-overrides-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner', model: 'opus', capabilities: ['review', 'merge'] },
    quill: { role: 'Writer', team: 'platform', reports_to: 'atlas', model: 'sonnet' },
    rune: { runtime: 'zen-agent', role: 'Platform engineer', team: 'platform', reports_to: 'atlas', model: 'openrouter/deepseek/deepseek-v4.1-flash', capabilities: ['code'] },
    sol: { role: 'Chief of staff', team: 'staff', reports_to: 'owner', capabilities: ['dispatch'] },
  },
  teams: { platform: { name: 'Platform', lead: 'atlas' }, staff: { name: 'Staff', lead: 'sol' } },
  channels: { 'all-hands': { members: '*' }, leads: { members: ['owner', 'atlas', 'sol'] } },
};

beforeEach(async () => {
  await truncateAll();
  await importOrg(ORG);
});

describe('write-time validation on the roster import', () => {
  it('refuses a zen-agent with an Anthropic alias, the ravi case', async () => {
    const bad = { ...ORG, agents: { ...ORG.agents, ravi: { runtime: 'zen-agent', role: 'Analyst', team: 'platform', reports_to: 'atlas', model: 'sonnet' } } };
    await expect(importOrg(bad)).rejects.toThrow(/provider\/model/);
  });

  it('refuses a claude-code agent on a non-Anthropic model and a runtime with no adapter', async () => {
    const wrongModel = { ...ORG, agents: { ...ORG.agents, quill: { ...ORG.agents.quill, model: 'openrouter/deepseek/deepseek-v4.1-flash' } } };
    await expect(importOrg(wrongModel)).rejects.toThrow(/Anthropic alias/);
    const noAdapter = { ...ORG, agents: { ...ORG.agents, quill: { ...ORG.agents.quill, runtime: 'codex' } } };
    await expect(importOrg(noAdapter)).rejects.toThrow(/no adapter/);
  });
});

describe('overrides', () => {
  it('only the owner writes or clears one; a bot, even a dispatch bot, cannot', async () => {
    await expect(setOverride('quill', 'quill', { model: 'opus' })).rejects.toThrow(/only the owner/);
    await expect(setOverride('sol', 'quill', { model: 'opus' })).rejects.toThrow(/only the owner/);
    await setOverride('owner', 'quill', { model: 'opus' });
    await expect(clearOverride('sol', 'quill')).rejects.toThrow(/only the owner/);
  });

  it('refuses a pair no adapter can run, naming the fix', async () => {
    await expect(setOverride('owner', 'quill', { runtime: 'zen-agent' })).rejects.toThrow(/needs --model provider\/model/);
    await expect(setOverride('owner', 'quill', { runtime: 'zen-agent', model: 'sonnet' })).rejects.toThrow(/provider\/model/);
    await expect(setOverride('owner', 'quill', { model: 'openrouter/x/y' })).rejects.toThrow(/Anthropic alias/);
    await expect(setOverride('owner', 'quill', { runtime: 'codex' })).rejects.toThrow(/no adapter/);
    await expect(setOverride('owner', 'nobody', { model: 'opus' })).rejects.toThrow(/no bot named/);
    expect(await listOverrides()).toHaveLength(0);
  });

  it('shows in the chart as the effective runtime and model, and clearing restores the roster', async () => {
    await setOverride('owner', 'quill', { model: 'opus', effort: 'high' });
    const quill = () => orgChart().then((c) => c.agents.find((a) => a.name === 'quill')!);
    expect(await quill()).toMatchObject({ runtime: 'claude-code', model: 'opus' });
    expect(await clearOverride('owner', 'quill')).toBe(true);
    expect(await quill()).toMatchObject({ runtime: 'claude-code', model: 'sonnet' });
    expect(await clearOverride('owner', 'quill')).toBe(false);
  });

  it('a switch from sonnet to zen-agent moves the bot between lanes on the next claim, with no deploy', async () => {
    const c = await createCard('owner', { title: 'Quill work', assignee: 'quill' });
    expect(await claimCard(null, { runtime: 'zen-agent', agent: 'quill' })).toBeNull(); // still a claude-code bot
    await setOverride('owner', 'quill', { runtime: 'zen-agent', model: 'openrouter/deepseek/deepseek-v4.1-flash' });
    expect(await claimCard(null, { runtime: 'claude-code', agent: 'quill' })).toBeNull(); // left the claude lane
    const got = await claimCard(null, { runtime: 'zen-agent', agent: 'quill' });
    expect(got!.id).toBe(c.id);
    const run = await query<{ runtime: string }>(`SELECT runtime FROM card_runs WHERE card_id = $1`, [c.id]);
    expect(run.rows[0]!.runtime).toBe('zen-agent'); // the run row records what it ran on
  });

  it('the overridden paused flag stops claims like the roster flag does', async () => {
    await createCard('owner', { title: 'Held', assignee: 'quill' });
    await query(`INSERT INTO org_agent_overrides (agent, model, paused, set_by) VALUES ('quill', 'opus', true, 'owner')`);
    expect(await claimCard(null, { agent: 'quill' })).toBeNull();
  });
});

describe('phase 1b exit check', () => {
  it('pause all leaves every ready card unclaimed, and resume releases them', async () => {
    const a = await createCard('owner', { title: 'A', assignee: 'quill' });
    const b = await createCard('owner', { title: 'B', assignee: 'rune' });
    await pauseAgents('owner', 'all', true, 'exit check');
    expect(await claimCard(null, { runtime: 'claude-code' })).toBeNull();
    expect(await claimCard(null, { runtime: 'zen-agent' })).toBeNull();
    expect((await getCard(a.id)).card.status).toBe('ready');
    expect((await getCard(b.id)).card.status).toBe('ready');
    await resumeAgents('owner', 'all');
    expect((await claimCard(null, { runtime: 'claude-code' }))!.id).toBe(a.id);
    expect((await claimCard(null, { runtime: 'zen-agent' }))!.id).toBe(b.id);
  });
});

describe('pauseLane', () => {
  it('pauses the bots whose effective runtime is X, once, and leaves the other lane running', async () => {
    await createCard('owner', { title: 'Zen', assignee: 'rune' });
    await createCard('owner', { title: 'Claude', assignee: 'quill' });
    expect(await pauseLane('sol', 'zen-agent', true, 'openrouter balance low')).toBe(1);
    expect(await pauseLane('sol', 'zen-agent', true, 'openrouter balance low')).toBe(0); // idempotent, no second audit line
    expect(await claimCard(null, { runtime: 'zen-agent' })).toBeNull();
    expect((await claimCard(null, { runtime: 'claude-code', agent: 'quill' }))!.title).toBe('Claude');
    const audit = await query<{ body: string }>(`SELECT body FROM org_messages WHERE channel_slug = 'platform' AND body LIKE 'paused: lane zen-agent%'`);
    expect(audit.rows).toHaveLength(1);
    await expect(pauseLane('quill', 'zen-agent', false, '')).rejects.toThrow(/may not pause or resume/);
    expect(await pauseLane('owner', 'zen-agent', false, '')).toBe(1);
  });

  it('follows an override: a bot moved onto zen-agent is paused with the zen lane', async () => {
    await setOverride('owner', 'quill', { runtime: 'zen-agent', model: 'openrouter/deepseek/deepseek-v4.1-flash' });
    expect(await pauseLane('owner', 'zen-agent', true, 'credits')).toBe(2); // rune and quill
  });
});
