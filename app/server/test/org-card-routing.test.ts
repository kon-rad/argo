import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { assignTask, botRepos, createTask, getAgent, importOrg, M4_ASSIGNEE, type KanbanRunner } from '../src/org.js';
import { truncateAll } from './helpers.js';

/**
 * Where a card's code lives decides who gets it (2026-10-21, t_47e2a857: a vault script given to rune dead-ended).
 * Vault work goes only to the M4 session, a bot's coding card names a bot repo, and the dispatch bot (sol) may give
 * any bot a card for its daily sweep.
 */

const ORG = {
  version: 'routing-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    sol: { role: 'Chief of Staff', team: 'office', reports_to: 'owner', capabilities: ['dispatch'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner' },
    rune: { role: 'Platform engineer', team: 'platform', reports_to: 'atlas', capabilities: ['code'] },
    juno: { role: 'Head of Media', team: 'media', reports_to: 'owner' },
    lena: { role: 'Writer', team: 'media', reports_to: 'juno' },
  },
  teams: { office: { name: 'Office', lead: 'sol' }, platform: { name: 'Platform', lead: 'atlas' }, media: { name: 'Media', lead: 'juno' } },
  channels: { 'all-hands': { members: '*' }, leads: { members: ['owner', 'sol', 'atlas', 'juno'] } },
};

const calls: string[][] = [];
const runner: KanbanRunner = async (args) => {
  calls.push(args);
  if (args.includes('show')) return JSON.stringify({ task: { title: 'Old card', status: 'ready' } });
  return JSON.stringify({ id: `t_${String(calls.length).padStart(6, '0')}` });
};
const arg = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('card routing by repo', () => {
  beforeEach(async () => {
    calls.length = 0;
    const dir = mkdtempSync(join(tmpdir(), 'sb-repos-'));
    writeFileSync(join(dir, 'bot-repos.toml'), `work_dir = "${dir}"\n\n[repos.argo-exo]\ngithub = "x/argo-exo"\n\n[repos.secondbrain]\ngithub = "x/secondbrain"\n`);
    writeFileSync(join(dir, 'created-repos.json'), JSON.stringify({ 'bot-made': { github: 'ArgoOrg/bot-made' } }));
    process.env.BOT_REPOS_FILE = join(dir, 'bot-repos.toml');
    await truncateAll();
    await importOrg(ORG);
    await query(`INSERT INTO projects (slug, title, team_slug, stage) VALUES ('argo-exo', 'Exo', 'platform', 'building')`);
  });

  it('reads the registry and the repos the bots created', () => {
    expect(botRepos()).toEqual(['argo-exo', 'secondbrain', 'bot-made']);
    expect(botRepos('/nonexistent/bot-repos.toml')).toBeNull();
  });

  it("a lead's coding card names a repo the bots reach", async () => {
    const atlas = await getAgent('atlas');
    const card = { assignee: 'rune', title: 'Build it', project: 'argo-exo', type: 'coding' };
    await expect(createTask(atlas, card, runner)).rejects.toThrow(/names its repo: --repo <name> \(one of argo-exo, secondbrain, bot-made\)/);
    await expect(createTask(atlas, { ...card, repo: 'secret-repo' }, runner)).rejects.toThrow(/no bot can push to secret-repo/);
    await expect(createTask(atlas, { ...card, repo: 'vault' }, runner)).rejects.toThrow(/vault code is worked by Claude Code on Konrad's M4.*task create m4/);
    const r = await createTask(atlas, { ...card, repo: 'bot-made' }, runner);
    expect(calls.at(-1)!.find((a) => a.startsWith('--body='))).toContain('Assigned by atlas. Repo: bot-made.');
    expect(r.link.assignee).toBe('rune');
  });

  it('vault work goes to the M4: a kanban assignee no dispatcher spawns, no board note', async () => {
    const atlas = await getAgent('atlas');
    const r = await createTask(atlas, { assignee: M4_ASSIGNEE, title: 'Build news_digest.py', project: 'argo-exo', type: 'coding' }, runner);
    const args = calls[0]!;
    expect(arg(args, '--assignee')).toBe('m4');
    expect(args.find((a) => a.startsWith('--body='))).toContain("Repo: vault. Worked by Claude Code on Konrad's M4; no bot wakes for it.");
    expect(r.link).toMatchObject({ assignee: 'm4', created_by: 'atlas' });
    expect(r.message).toBeNull();
    await expect(createTask(atlas, { assignee: M4_ASSIGNEE, title: 'Exo fix', project: 'argo-exo', repo: 'argo-exo' }, runner)).rejects.toThrow(/m4 takes vault work only/);
    await expect(createTask(await getAgent('rune'), { assignee: M4_ASSIGNEE, title: 'x', project: 'argo-exo' }, runner)).rejects.toThrow(/rune can't give the M4 a card: leads do/);
  });

  it('an existing card moves to the M4 with assign', async () => {
    const r = await assignTask(await getAgent('owner'), { taskId: 't_47e2a857', assignee: M4_ASSIGNEE, project: 'argo-exo', repo: 'vault' }, runner);
    expect(calls.find((c) => c.includes('assign'))).toEqual(['kanban', '--board', 'exo', 'assign', 't_47e2a857', 'm4']);
    expect(r.link.assignee).toBe('m4');
  });

  it('sol (dispatch) gives any bot a card; another lead still only its own team', async () => {
    const r = await assignTask(await getAgent('sol'), { taskId: 't_aaaaaa', assignee: 'lena', project: 'argo-exo' }, runner);
    expect(r.link).toMatchObject({ assignee: 'lena', created_by: 'sol' });
    expect(r.message).toMatchObject({ channel_slug: 'leads', body: 'card t_aaaaaa for lena: Old card (argo-exo)', mentions: [] });
    await expect(assignTask(await getAgent('atlas'), { taskId: 't_bbbbbb', assignee: 'lena', project: 'argo-exo' }, runner))
      .rejects.toThrow(/atlas can't give lena a card/);
  });

  it('dispatch is a power, not something a card can need', async () => {
    await expect(createTask(await getAgent('owner'), { assignee: 'sol', title: 'x', project: 'argo-exo', needs: 'dispatch' }, runner)).rejects.toThrow(/--needs dispatch/);
  });
});
