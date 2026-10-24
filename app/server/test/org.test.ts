import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatMessage, identityName, main, notifyOwner, parseArgs, parseSince } from '../src/cli-org.js';
import { config } from '../src/config.js';
import { query } from '../src/db.js';
import {
  addWakeup,
  askOwner,
  claimWakeups,
  dm,
  finishWakeups,
  getSession,
  releaseClaimed,
  setSession,
  taskWakeHold,
  dmSlug,
  getAgent,
  getThread,
  handoff,
  importOrg,
  listChannels,
  openWakeups,
  orgChart,
  OrgError,
  post,
  readMessages,
  searchMessages,
  standup,
  unreadCounts,
  whoami,
} from '../src/org.js';
import { truncateAll } from './helpers.js';

const ORG = {
  version: 'test-1',
  company: 'Argo',
  ceo: 'owner',
  agents: {
    owner: { runtime: 'human', role: 'CEO', channels: ['*'] },
    atlas: { role: 'Head of Platform', team: 'platform', reports_to: 'owner', model: 'opus' },
    rune: { role: 'Platform engineer', team: 'platform', reports_to: 'atlas' },
    vera: { role: 'Reviewer', team: 'platform', reports_to: 'atlas' },
    juno: { role: 'Head of Media', team: 'media', reports_to: 'owner', model: 'opus' },
    lena: { role: 'Writer', team: 'media', reports_to: 'juno' },
  },
  teams: {
    platform: { name: 'Platform & Agents', lead: 'atlas' },
    media: { name: 'Media & Growth', lead: 'juno' },
  },
  channels: {
    'all-hands': { members: '*', purpose: 'company-wide' },
    leads: { members: ['owner', 'atlas', 'juno'], purpose: 'leads' },
    'launch-room': { members: ['platform', 'media'], purpose: 'handoffs', classification: 'confidential', compartments: ['unreleased'] },
  },
};

async function wakeups(agent: string): Promise<{ reason: string; ref: string | null }[]> {
  return (await openWakeups(agent)).map((w) => ({ reason: w.reason, ref: w.ref }));
}

describe('cli helpers', () => {
  it('parses positionals and flags', () => {
    expect(parseArgs(['platform', 'hello', '--kind', 'status', '--json'])).toEqual({ pos: ['platform', 'hello'], opts: { kind: 'status', json: true } });
  });
  it('identity comes from ORG_AGENT only', () => {
    expect(identityName({ ORG_AGENT: 'rune' })).toBe('rune');
    expect(() => identityName({})).toThrow(OrgError);
  });
  it('parses --since', () => {
    expect(parseSince('24h')).toBe(24);
    expect(parseSince('3d')).toBe(72);
    expect(parseSince('90m')).toBe(1.5);
    expect(() => parseSince('soon')).toThrow(OrgError);
  });
  it('formats a message for a model to read', () => {
    const s = formatMessage({
      id: 7, channel_slug: 'platform', thread_id: 3, author: 'rune', kind: 'status', body: 'ran tests\n12 pass', mentions: [], urgent: false,
      task_id: 't_1', project_slug: null, feature_slug: null, run_id: null, created_at: new Date('2026-10-15T01:02:03Z'),
    });
    expect(s).toBe('#platform 7 2026-10-15 01:02 rune [status] (re:3 task t_1)\n  ran tests\n  12 pass');
  });
  it('reports a missing notifier without failing', async () => {
    expect(await notifyOwner('x', { ORG_NOTIFY_CMD: '/nonexistent/org-notify.sh' })).toMatch(/no notifier/);
  });
  it('runs the notifier and relays its output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'org-notify-'));
    const script = join(dir, 'notify.sh');
    writeFileSync(script, '#!/bin/sh\necho "got: $1"\n', { mode: 0o755 });
    expect(await notifyOwner('[org] atlas asks (#1): hi', { ORG_NOTIFY_CMD: script })).toBe("urgent: sent to the owner's phone (got: [org] atlas asks (#1): hi)");
    writeFileSync(script, '#!/bin/sh\necho "boom" >&2; exit 3\n', { mode: 0o755 });
    expect(await notifyOwner('x', { ORG_NOTIFY_CMD: script })).toMatch(/notifier failed .*\nboom/);
  });
});

describe('import', () => {
  beforeEach(truncateAll);

  it('creates agents, teams, channels and memberships, idempotently', async () => {
    const r = await importOrg(ORG);
    expect(r).toEqual({ agents: 6, teams: 2, channels: 7, retired: 0 });
    const again = await importOrg(ORG);
    expect(again.agents).toBe(6);
    const { rows: teams } = await query<{ slug: string; lead: string; members: string[] }>(`SELECT slug, lead, members FROM teams ORDER BY slug`);
    expect(teams).toEqual([
      { slug: 'media', lead: 'juno', members: ['juno', 'lena'] },
      { slug: 'platform', lead: 'atlas', members: ['atlas', 'rune', 'vera'] },
    ]);
    const { rows: members } = await query<{ channel_slug: string; n: number }>(`SELECT channel_slug, count(*)::int AS n FROM org_channel_members GROUP BY 1 ORDER BY 1`);
    expect(members).toEqual([
      { channel_slug: 'all-hands', n: 6 },
      { channel_slug: 'launch-room', n: 6 },
      { channel_slug: 'leads', n: 3 },
      { channel_slug: 'media', n: 3 },
      { channel_slug: 'media-standup', n: 3 },
      { channel_slug: 'platform', n: 4 },
      { channel_slug: 'platform-standup', n: 4 },
    ]);
    expect((await getAgent('rune')).reports_to).toBe('atlas');
  });

  it('retires agents dropped from the file and keeps their messages', async () => {
    await importOrg(ORG);
    await post(await getAgent('vera'), 'platform', 'last words');
    const smaller = { ...ORG, agents: Object.fromEntries(Object.entries(ORG.agents).filter(([n]) => n !== 'vera')) };
    const r = await importOrg(smaller);
    expect(r.retired).toBe(1);
    await expect(getAgent('vera')).rejects.toThrow(/retired/);
    const { rows } = await query(`SELECT 1 FROM org_messages WHERE author = 'vera'`);
    expect(rows.length).toBe(1);
    const { rows: m } = await query(`SELECT 1 FROM org_channel_members WHERE agent_name = 'vera'`);
    expect(m.length).toBe(0);
    await importOrg(ORG);
    expect((await getAgent('vera')).retired_at).toBeNull();
  });

  it('rejects a broken hierarchy', async () => {
    await expect(importOrg({ ...ORG, agents: { ...ORG.agents, lena: { role: 'Writer', team: 'media', reports_to: 'atlas' } } })).rejects.toThrow(/reports_to must be juno or owner/);
    const lenaUnderRune = { ...ORG.agents, lena: { role: 'Writer', team: 'media', reports_to: 'rune' } };
    await expect(importOrg({ ...ORG, agents: lenaUnderRune, teams: { ...ORG.teams, media: { name: 'Media', lead: 'rune' } } })).rejects.toThrow(/lead rune is not on the team/);
    await expect(importOrg({ ...ORG, channels: { ...ORG.channels, x: { members: ['nobody'] } } })).rejects.toThrow(/unknown member nobody/);
  });
});

describe('membership and reading', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
  });

  it('refuses a non-member read and post', async () => {
    const lena = await getAgent('lena');
    await expect(readMessages(lena, { channel: 'platform' })).rejects.toThrow('lena is not a member of #platform');
    await expect(post(lena, 'platform', 'hi')).rejects.toThrow('not a member');
    await expect(post(lena, 'nowhere', 'hi')).rejects.toThrow('no channel #nowhere');
  });

  it('owner reads and posts anywhere', async () => {
    const owner = await getAgent('owner');
    await post(owner, 'platform', 'morning');
    const rune = await getAgent('rune');
    const ms = await readMessages(rune);
    expect(ms.map((m) => [m.channel_slug, m.author, m.body])).toEqual([['platform', 'owner', 'morning']]);
    expect((await readMessages(owner, { channel: 'media' })).length).toBe(0);
  });

  it('read returns unread across channels, marks them, and --all shows history', async () => {
    const atlas = await getAgent('atlas');
    const rune = await getAgent('rune');
    await post(atlas, 'platform', 'first');
    await post(atlas, 'all-hands', 'hello all');
    await post(rune, 'platform', 'my own post');
    expect(await unreadCounts(rune)).toEqual({ platform: 1, 'all-hands': 1 });
    const ms = await readMessages(rune);
    expect(ms.map((m) => m.body)).toEqual(['first', 'hello all']);
    expect(await unreadCounts(rune)).toEqual({});
    expect(await readMessages(rune)).toEqual([]);
    const all = await readMessages(rune, { unreadOnly: false, channel: 'platform' });
    expect(all.map((m) => m.body)).toEqual(['first', 'my own post']);
    const w = await whoami(rune);
    expect(w.team?.lead).toBe('atlas');
    expect(w.is_lead).toBe(false);
    expect(w.channels.map((c) => c.slug).sort()).toEqual(['all-hands', 'launch-room', 'platform', 'platform-standup']);
  });

  it('filters by kind and age', async () => {
    const atlas = await getAgent('atlas');
    await post(atlas, 'platform', 'a status', { kind: 'status' });
    await post(atlas, 'platform', 'a decision', { kind: 'decision' });
    await query(`UPDATE org_messages SET created_at = now() - interval '2 days' WHERE body = 'a status'`);
    const rune = await getAgent('rune');
    expect((await readMessages(rune, { kinds: ['decision'], mark: false })).map((m) => m.body)).toEqual(['a decision']);
    expect((await readMessages(rune, { sinceHours: 24, mark: false })).map((m) => m.body)).toEqual(['a decision']);
    expect((await readMessages(rune, { mark: false })).length).toBe(2);
  });

  it('threads stay in their channel', async () => {
    const atlas = await getAgent('atlas');
    const rune = await getAgent('rune');
    const root = await post(atlas, 'platform', 'plan?');
    const reply = await post(rune, 'platform', 'yes', { thread: root.id });
    expect(reply.kind).toBe('reply');
    await expect(post(rune, 'all-hands', 'wrong room', { thread: root.id })).rejects.toThrow(/is in #platform/);
    await expect(post(rune, 'platform', 'nested', { thread: reply.id })).rejects.toThrow(/itself a reply/);
    expect((await getThread(rune, reply.id)).map((m) => m.body)).toEqual(['plan?', 'yes']);
    await expect(getThread(await getAgent('lena'), root.id)).rejects.toThrow('not a member');
  });

  it('searches only the caller’s channels', async () => {
    const atlas = await getAgent('atlas');
    await post(atlas, 'platform', 'migration applied on the droplet');
    await post(atlas, 'all-hands', 'migration day');
    expect((await searchMessages(await getAgent('lena'), 'migration')).map((m) => m.channel_slug)).toEqual(['all-hands']);
    expect((await searchMessages(await getAgent('rune'), 'migration')).length).toBe(2);
  });

  it('lists channels with unread counts', async () => {
    await post(await getAgent('atlas'), 'platform', 'x');
    const cs = await listChannels(await getAgent('rune'));
    expect(cs.find((c) => c.slug === 'platform')).toMatchObject({ kind: 'team', members: 4, unread: 1 });
  });
});

describe('DMs, handoffs, mentions and the wakeups they insert', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
  });

  it('member to lead DM creates the channel and one wakeup', async () => {
    const rune = await getAgent('rune');
    const m = await dm(rune, 'atlas', 'tests pass, review?');
    expect(m.channel_slug).toBe(dmSlug('atlas', 'rune'));
    expect(m.channel_slug).toBe('dm:atlas:rune');
    expect(await wakeups('atlas')).toEqual([{ reason: 'dm', ref: String(m.id) }]);
    expect(await wakeups('rune')).toEqual([]);
    const atlas = await getAgent('atlas');
    expect((await readMessages(atlas)).map((x) => x.body)).toEqual(['tests pass, review?']);
    const back = await dm(atlas, 'rune', 'looking');
    expect(back.channel_slug).toBe('dm:atlas:rune');
    expect(await wakeups('rune')).toEqual([{ reason: 'dm', ref: String(back.id) }]);
  });

  it('enforces the DM pairs', async () => {
    await expect(dm(await getAgent('rune'), 'lena', 'hi')).rejects.toThrow(/stay inside a team or between leads/);
    await expect(dm(await getAgent('rune'), 'owner', 'hi')).rejects.toThrow(/through your lead/);
    await expect(dm(await getAgent('rune'), 'rune', 'hi')).rejects.toThrow(/yourself/);
    await expect(dm(await getAgent('atlas'), 'juno', 'lead to lead')).resolves.toMatchObject({ channel_slug: 'dm:atlas:juno' });
    await expect(dm(await getAgent('rune'), 'vera', 'same team')).resolves.toMatchObject({ channel_slug: 'dm:rune:vera' });
    const k = await dm(await getAgent('owner'), 'lena', 'from the ceo');
    expect(await wakeups('lena')).toEqual([{ reason: 'owner', ref: String(k.id) }]);
    await expect(dm(await getAgent('atlas'), 'rune', 'x', { kind: 'standup' })).rejects.toThrow(/can't be a standup/);
  });

  it('a handoff in a shared channel wakes the agent and, across teams, its lead', async () => {
    const atlas = await getAgent('atlas');
    const m = await handoff(atlas, 'launch-room', 'lena', 'write the release note', { task: 't_1' });
    expect(m.kind).toBe('handoff');
    expect(m.mentions).toEqual(['lena']);
    expect(await wakeups('lena')).toEqual([{ reason: 'handoff', ref: String(m.id) }]);
    expect(await wakeups('juno')).toEqual([{ reason: 'handoff', ref: String(m.id) }]);
    const same = await handoff(atlas, 'platform', 'rune', 'take the migration');
    expect(await wakeups('rune')).toEqual([{ reason: 'handoff', ref: String(same.id) }]);
    expect((await wakeups('atlas')).length).toBe(0);
    await expect(handoff(atlas, 'platform', 'lena', 'x')).rejects.toThrow(/lena is not in #platform/);
    await expect(handoff(atlas, 'dm:atlas:rune', 'rune', 'x')).rejects.toThrow(/no channel/);
  });

  it('@mentions wake members of the channel only', async () => {
    const atlas = await getAgent('atlas');
    const m = await post(atlas, 'platform', 'can @vera and @lena look? @nobody too');
    expect(m.mentions).toEqual(['vera', 'lena']);
    expect(await wakeups('vera')).toEqual([{ reason: 'mention', ref: String(m.id) }]);
    expect(await wakeups('lena')).toEqual([]);
    await post(atlas, 'platform', 'again @vera');
    expect((await wakeups('vera')).length).toBe(2);
    await expect(post(atlas, 'platform', 'x', { mentions: ['ghost'] })).rejects.toThrow(/unknown agent "ghost"/);
  });

  it('a post with an unknown project is refused', async () => {
    await expect(post(await getAgent('atlas'), 'platform', 'x', { project: 'nope' })).rejects.toThrow(/no project "nope"/);
  });
});

describe('ask-owner and standup', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
  });

  it('only leads ask, nobody is woken, urgent is capped', async () => {
    await expect(askOwner(await getAgent('rune'), 'may I?')).rejects.toThrow(/not a lead; DM your lead \(atlas\)/);
    await expect(askOwner(await getAgent('owner'), 'x')).rejects.toThrow(/you are the owner/);
    const atlas = await getAgent('atlas');
    const q = await askOwner(atlas, 'ship phase 1?');
    expect(q).toMatchObject({ channel_slug: 'leads', kind: 'question-for-owner', urgent: false });
    expect(await openWakeups()).toEqual([]);
    for (let i = 0; i < 3; i++) await askOwner(atlas, `urgent ${i}`, { urgent: true });
    await expect(askOwner(atlas, 'one more', { urgent: true })).rejects.toThrow(/already sent 3 urgent/);
    await expect(askOwner(atlas, 'not urgent is fine')).resolves.toBeTruthy();
    const owner = await getAgent('owner');
    const qs = await readMessages(owner, { kinds: ['question-for-owner'], sinceHours: 24 });
    expect(qs.length).toBe(5);
    expect(qs.filter((m) => m.urgent).length).toBe(3);
  });

  it('a lead posts one stand-up a day in its team channel', async () => {
    const atlas = await getAgent('atlas');
    const s = await standup(atlas, 'shipped: migration. moving: cli. blocked: none.');
    expect(s).toMatchObject({ channel_slug: 'platform-standup', kind: 'standup' });
    await expect(standup(atlas, 'again')).rejects.toThrow(/already posted today/);
    await expect(standup(await getAgent('rune'), 'x')).rejects.toThrow(/not a team lead/);
    const owner = await getAgent('owner');
    expect((await readMessages(owner, { kinds: ['standup'] })).map((m) => m.author)).toEqual(['atlas']);
  });
});

describe('cli main', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
  });

  it('runs whoami, post, read and agents as the ORG_AGENT', async () => {
    const lines: string[] = [];
    const out = (s: string): void => void lines.push(s);
    process.env.ORG_AGENT = 'rune';
    try {
      expect(await main(['whoami'], out)).toBe(0);
      expect(lines[0]).toBe('rune: Platform engineer on Platform & Agents (platform), reports to atlas');
      lines.length = 0;
      expect(await main(['post', 'platform', 'hello @vera'], out)).toBe(0);
      expect(lines[0]).toMatch(/^posted \d+ in #platform \(mentions vera\)$/);
      lines.length = 0;
      process.env.ORG_AGENT = 'vera';
      expect(await main(['read'], out)).toBe(0);
      expect(lines[0]).toMatch(/^#platform \d+ .* rune \[message\]\n  hello @vera$/);
      lines.length = 0;
      expect(await main(['read'], out)).toBe(0);
      expect(lines[0]).toBe('nothing new');
      lines.length = 0;
      expect(await main(['wakeups'], out)).toBe(0);
      expect(lines[0]).toMatch(/^\d+ vera mention \d+ /);
      lines.length = 0;
      expect(await main(['agents'], out)).toBe(0);
      expect(lines[0]).toBe('owner      CEO  (human)');
      expect(lines.find((l) => l.startsWith('atlas'))).toMatch(/\[Platform & Agents, lead\] {2}reports to owner {2}\(claude-code, opus\)/);
      lines.length = 0;
      expect(await main(['nonsense'], out)).toBe(1);
      delete process.env.ORG_AGENT;
      await expect(main(['whoami'], out)).rejects.toThrow(/ORG_AGENT is not set/);
    } finally {
      delete process.env.ORG_AGENT;
    }
  });
});

describe('dispatcher side: claim, finish, add, session', () => {
  beforeEach(async () => {
    await truncateAll();
    await importOrg(ORG);
  });

  it('claims every open wakeup of an agent once, finishes them, and posts a fallback status when the run was silent', async () => {
    const rune = await getAgent('rune');
    const atlas = await getAgent('atlas');
    const a = await dm(rune, 'atlas', 'one');
    const b = await dm(rune, 'atlas', 'two');
    const claimed = await claimWakeups('atlas', 'run-1');
    expect(claimed.map((w) => w.ref).sort()).toEqual([String(a.id), String(b.id)].sort());
    expect(await claimWakeups('atlas', 'run-2')).toEqual([]);
    expect((await openWakeups('atlas')).every((w) => w.claimed_at)).toBe(true);
    const r = await finishWakeups(claimed.map((w) => w.id), { run: 'run-1', exit: 1, result: 'Error: boom' });
    expect(r).toEqual({ done: 2, fallback_posted: true });
    expect(await openWakeups('atlas')).toEqual([]);
    const last = (await readMessages(await getAgent('vera'), { channel: 'platform', unreadOnly: false })).at(-1)!;
    expect(last).toMatchObject({ author: 'atlas', kind: 'status', run_id: 'run-1' });
    expect(last.body).toMatch(/^status: run ended without a report \(exit 1\)\. Last output: Error: boom$/);
    // A run that reported gets no fallback.
    const c = await dm(rune, 'atlas', 'three');
    const again = await claimWakeups('atlas', 'run-3');
    await post(atlas, 'platform', 'did the thing', { kind: 'status', run: 'run-3' });
    expect(await finishWakeups(again.map((w) => w.id), { run: 'run-3', exit: 0 })).toEqual({ done: 1, fallback_posted: false });
    void c;
    await expect(finishWakeups([], {})).rejects.toThrow(/at least one/);
  });

  it('adds routine and task wakeups without duplicates, never for a human', async () => {
    expect(await addWakeup('atlas', 'routine', 'daily-standup')).toEqual(expect.any(Number));
    expect(await addWakeup('atlas', 'routine', 'daily-standup')).toBeNull();
    expect(await addWakeup('rune', 'task', 't_1')).toEqual(expect.any(Number));
    await expect(addWakeup('owner', 'owner', 'x')).rejects.toThrow(/human/);
    await expect(addWakeup('ghost', 'task', 't_1')).rejects.toThrow(/unknown agent/);
    const [w] = await claimWakeups('atlas', 'r');
    await finishWakeups([w!.id]);
    // One routine per local day (ORG_TZ): the finished one still counts until tomorrow.
    expect(await addWakeup('atlas', 'routine', 'daily-standup')).toBeNull();
    await query(`UPDATE org_wakeups SET created_at = created_at - interval '1 day' WHERE id = $1`, [w!.id]);
    expect(await addWakeup('atlas', 'routine', 'daily-standup')).toEqual(expect.any(Number));
  });

  it('releases claimed but unfinished wakeups after a restart', async () => {
    const rune = await getAgent('rune');
    await dm(rune, 'atlas', 'a');
    const claimed = await claimWakeups('atlas', 'run-dead');
    await finishWakeups([claimed[0]!.id]);
    await dm(rune, 'atlas', 'b');
    await claimWakeups('atlas', 'run-dead-2');
    expect(await releaseClaimed()).toBe(1);
    expect((await openWakeups('atlas')).map((w) => w.claimed_at)).toEqual([null]);
    expect((await claimWakeups('atlas', 'run-new')).length).toBe(1);
  });

  it('remembers and clears the session', async () => {
    expect(await getSession('rune')).toEqual({ session_id: null, session_started: null, session_runs: 0 });
    await setSession('rune', 'sess-abc');
    const s = await getSession('rune');
    expect(s.session_id).toBe('sess-abc');
    expect(s.session_started).toBeInstanceOf(Date);
    expect(s.session_runs).toBe(1);
    expect((await orgChart()).agents.find((a) => a.name === 'rune')?.session_id).toBe('sess-abc');
    await setSession('rune', null);
    expect(await getSession('rune')).toEqual({ session_id: null, session_started: null, session_runs: 0 });
  });

  it('drops a session once it has carried ORG_SESSION_MAX_RUNS runs, so the next wake starts fresh', async () => {
    expect(config.orgSessionMaxRuns).toBe(3);
    expect((await setSession('rune', 's1')).session_runs).toBe(1);
    expect((await setSession('rune', 's1')).session_runs).toBe(2);
    expect(await setSession('rune', 's1')).toEqual({ session_id: null, session_started: null, session_runs: 0 });
    expect(await setSession('rune', 's2')).toMatchObject({ session_id: 's2', session_runs: 1 });
    const saved = config.orgSessionMaxRuns;
    config.orgSessionMaxRuns = 1;
    try {
      expect((await setSession('atlas', 's3')).session_id).toBeNull();
    } finally {
      config.orgSessionMaxRuns = saved;
    }
  });

  it('backs off a card that keeps waking its bot, then holds it for a person', async () => {
    expect([config.orgTaskWakeRetries, config.orgTaskWakeBackoffMinutes]).toEqual([2, 15]);
    const runOnce = async (): Promise<void> => {
      const [w] = await claimWakeups('rune', 'r');
      await finishWakeups([w!.id]);
    };
    // Pretend the last finished wake for the card ended this many minutes ago.
    const age = (minutes: number): Promise<unknown> =>
      query(`UPDATE org_wakeups SET done_at = now() - make_interval(mins => $1) WHERE ref = 't_9' AND done_at IS NOT NULL`, [minutes]);

    expect(await addWakeup('rune', 'task', 't_9')).toEqual(expect.any(Number));
    await runOnce();
    expect(await addWakeup('rune', 'task', 't_9')).toBeNull();
    expect(await taskWakeHold('rune', 't_9')).toMatchObject({ reason: 'backoff', runs: 1 });
    await age(16);
    expect(await addWakeup('rune', 'task', 't_9')).toEqual(expect.any(Number));
    await runOnce();
    await age(16);
    expect(await taskWakeHold('rune', 't_9')).toMatchObject({ reason: 'backoff', runs: 2 }); // 30 min now
    await age(31);
    expect(await addWakeup('rune', 'task', 't_9')).toEqual(expect.any(Number));
    await runOnce();
    await age(600);
    expect(await taskWakeHold('rune', 't_9')).toEqual({ reason: 'cap', runs: 3, until: null });
    expect(await addWakeup('rune', 'task', 't_9')).toBeNull();
    expect(await addWakeup('rune', 'task', 't_9')).toBeNull();
    const { rows } = await query<{ body: string }>(`SELECT body FROM org_messages WHERE author = 'rune' AND task_id = 't_9'`);
    expect(rows.map((r) => r.body)).toEqual([expect.stringMatching(/^held: card t_9 woke rune 3 times in 24 h/)]);
    // Other cards, routines and the owner's nudge are not held.
    expect(await addWakeup('rune', 'task', 't_10')).toEqual(expect.any(Number));
    expect(await addWakeup('rune', 'owner', 't_9')).toEqual(expect.any(Number));
    await age(24 * 60 + 1);
    expect(await taskWakeHold('rune', 't_9')).toBeNull();
  });

  it('cli: wake-claim, wake-done, wake-add, session', async () => {
    const lines: string[] = [];
    const out = (s: string): void => void lines.push(s);
    await dm(await getAgent('rune'), 'atlas', 'hi');
    expect(await main(['wake-claim', 'atlas', '--by', 'run-9', '--json'], out)).toBe(0);
    const ws = JSON.parse(lines[0]!) as { id: number }[];
    expect(ws.length).toBe(1);
    lines.length = 0;
    expect(await main(['wake-done', String(ws[0]!.id), '--run', 'run-9', '--exit', '0', '--result', 'ok'], out)).toBe(0);
    expect(lines[0]).toBe('done 1 wakeup(s); posted a fallback status');
    lines.length = 0;
    expect(await main(['wake-add', 'rune', '--reason', 'routine', '--ref', 'weekly'], out)).toBe(0);
    expect(lines[0]).toMatch(/^wakeup \d+ for rune$/);
    lines.length = 0;
    expect(await main(['session', 'rune', '--set', 's1'], out)).toBe(0);
    expect(lines[0]).toMatch(/^rune: session s1 since \d{4}-\d{2}-\d{2}, 1 run\(s\)$/);
    lines.length = 0;
    expect(await main(['session', 'rune', '--clear'], out)).toBe(0);
    expect(lines[0]).toBe('rune: no session');
    lines.length = 0;
    expect(await main(['wake-add', 'rune', '--reason', 'task', '--ref', 't_5'], out)).toBe(0);
    await finishWakeups((await claimWakeups('rune', 'r5')).map((w) => w.id));
    expect(await main(['wake-add', 'rune', '--reason', 'task', '--ref', 't_5'], out)).toBe(0);
    expect(lines[1]).toMatch(/^rune: card t_5 held until \d{4}-.*Z \(1 run\(s\) in 24 h\)$/);
    await expect(main(['wake-done', 'x'], out)).rejects.toThrow(/wake-done/);
  });
});

