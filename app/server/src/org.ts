import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { query, withTransaction, type TxClient } from './db.js';

/**
 * The agent company's message board: agents on teams, channels, DMs, messages,
 * read cursors and wakeups. The CLI (cli-org) and the app's /api/org routes
 * call these; the identity of the caller always comes from the environment
 * (ORG_AGENT), never from a message body.
 *
 * Membership is the access control: every read and post checks it. The one
 * exception is the human agent (the owner), who reads and posts anywhere. DMs are
 * allowed between agents on the same team, between two leads, and from a
 * human to anyone; a member reaches the owner through its lead, a lead through
 * ask-owner. Leads are the agents named as `lead` on a team.
 *
 */

export class OrgError extends Error {}

export const KINDS = ['message', 'status', 'decision', 'handoff', 'question-for-owner', 'standup', 'reflection', 'reply'] as const;
export type Kind = (typeof KINDS)[number];
/** Kinds a plain `post` may use; the others have their own commands with their own rules. */
export const POST_KINDS = ['message', 'status', 'decision', 'reflection', 'reply'] as const;
export const URGENT_PER_DAY = 3;

const Name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'lowercase letters, digits and dashes');
const Body = z.string().trim().min(1).max(8000);

export const OrgDoc = z.object({
  version: z.string().min(1),
  company: z.string().min(1),
  ceo: Name,
  agents: z.record(
    Name,
    z.object({
      runtime: z.enum(['claude-code', 'hermes', 'codex', 'human']).default('claude-code'),
      role: z.string().min(1),
      team: Name.optional(),
      reports_to: Name.optional(),
      model: z.string().optional(),
      expertise: z.string().optional(),
      channels: z.array(z.string()).optional(),
    }),
  ),
  teams: z.record(
    Name,
    z.object({
      name: z.string().min(1),
      lead: Name,
      division: z.string().optional(),
      channels: z.array(z.string()).optional(),
    }),
  ),
  channels: z.record(
    z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
    z.object({
      members: z.union([z.literal('*'), z.array(Name)]),
      purpose: z.string().optional(),
      classification: z.string().optional(),
      compartments: z.array(z.string()).optional(),
    }),
  ),
});
export type OrgDocT = z.infer<typeof OrgDoc>;

export interface Agent {
  name: string;
  team_slug: string | null;
  runtime: string;
  role: string;
  reports_to: string | null;
  model: string | null;
  expertise: string | null;
  retired_at: Date | null;
}

export interface Message {
  id: number;
  channel_slug: string;
  thread_id: number | null;
  author: string;
  kind: Kind;
  body: string;
  mentions: string[];
  urgent: boolean;
  task_id: string | null;
  project_slug: string | null;
  feature_slug: string | null;
  run_id: string | null;
  created_at: Date;
}

const MESSAGE_COLS = 'id, channel_slug, thread_id, author, kind, body, mentions, urgent, task_id, project_slug, feature_slug, run_id, created_at';

// ---------------------------------------------------------------------------
// Import: the compiled org file → agents, teams, channels, memberships
// ---------------------------------------------------------------------------

/**
 * Upserts everything the org file describes. Idempotent. Agents missing from
 * the file are retired (never deleted: messages keep their author); agents
 * present again are un-retired. Team channels are `<team>` and
 * `<team>-standup` unless the team lists its own. A human agent (the CEO) is a
 * member of every team and shared channel.
 */
export async function importOrg(input: unknown): Promise<{ agents: number; teams: number; channels: number; retired: number }> {
  const doc = OrgDoc.parse(input);
  const ceo = doc.agents[doc.ceo];
  if (!ceo) throw new OrgError(`ceo "${doc.ceo}" is not in agents`);
  for (const [name, a] of Object.entries(doc.agents)) {
    if (a.runtime === 'human') continue;
    if (!a.team) throw new OrgError(`agent ${name} has no team`);
    if (!doc.teams[a.team]) throw new OrgError(`agent ${name}: unknown team ${a.team}`);
    if (!a.reports_to) throw new OrgError(`agent ${name} has no reports_to`);
    const lead = doc.teams[a.team]!.lead;
    if (a.reports_to !== doc.ceo && a.reports_to !== lead) throw new OrgError(`agent ${name}: reports_to must be ${lead} or ${doc.ceo}`);
  }
  for (const [slug, t] of Object.entries(doc.teams)) {
    if (doc.agents[t.lead]?.team !== slug) throw new OrgError(`team ${slug}: lead ${t.lead} is not on the team`);
  }

  return withTransaction(async (tx) => {
    const humans = Object.entries(doc.agents).filter(([, a]) => a.runtime === 'human').map(([n]) => n);
    const byTeam = (slug: string): string[] => Object.entries(doc.agents).filter(([, a]) => a.team === slug).map(([n]) => n);

    for (const [slug, t] of Object.entries(doc.teams)) {
      await tx.query(
        `INSERT INTO teams (slug, name, lead, members) VALUES ($1,$2,$3,$4)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, lead = EXCLUDED.lead, members = EXCLUDED.members, updated_at = now()`,
        [slug, t.name, t.lead, byTeam(slug)],
      );
    }

    // Two passes: reports_to is a self-reference.
    for (const [name, a] of Object.entries(doc.agents)) {
      await tx.query(
        `INSERT INTO org_agents (name, team_slug, runtime, role, model, expertise, org_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (name) DO UPDATE SET team_slug = EXCLUDED.team_slug, runtime = EXCLUDED.runtime, role = EXCLUDED.role,
           model = EXCLUDED.model, expertise = EXCLUDED.expertise, org_version = EXCLUDED.org_version, retired_at = NULL, updated_at = now()`,
        [name, a.team ?? null, a.runtime, a.role, a.model ?? null, a.expertise ?? null, doc.version],
      );
    }
    for (const [name, a] of Object.entries(doc.agents)) {
      await tx.query(`UPDATE org_agents SET reports_to = $2 WHERE name = $1`, [name, a.reports_to ?? null]);
    }
    const { rowCount: retired } = await tx.query(
      `UPDATE org_agents SET retired_at = now(), updated_at = now() WHERE retired_at IS NULL AND NOT (name = ANY ($1))`,
      [Object.keys(doc.agents)],
    );

    let channels = 0;
    const setMembers = async (slug: string, members: string[]): Promise<void> => {
      const all = [...new Set([...members, ...humans])];
      await tx.query(`DELETE FROM org_channel_members WHERE channel_slug = $1 AND NOT (agent_name = ANY ($2))`, [slug, all]);
      for (const m of all) {
        await tx.query(`INSERT INTO org_channel_members (channel_slug, agent_name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [slug, m]);
      }
    };
    for (const [slug, t] of Object.entries(doc.teams)) {
      for (const ch of t.channels ?? [slug, `${slug}-standup`]) {
        await tx.query(
          `INSERT INTO org_channels (slug, kind, team_slug, purpose) VALUES ($1,'team',$2,$3)
           ON CONFLICT (slug) DO UPDATE SET kind = 'team', team_slug = EXCLUDED.team_slug, purpose = EXCLUDED.purpose`,
          [ch, slug, ch.endsWith('-standup') ? `${t.name}: daily stand-up posts by the lead` : `${t.name}: the team's channel`],
        );
        await setMembers(ch, byTeam(slug));
        channels++;
      }
    }
    for (const [slug, c] of Object.entries(doc.channels)) {
      await tx.query(
        `INSERT INTO org_channels (slug, kind, purpose, classification, compartments) VALUES ($1,'shared',$2,$3,$4)
         ON CONFLICT (slug) DO UPDATE SET kind = 'shared', purpose = EXCLUDED.purpose, classification = EXCLUDED.classification, compartments = EXCLUDED.compartments`,
        [slug, c.purpose ?? null, c.classification ?? null, c.compartments ?? []],
      );
      const members =
        c.members === '*'
          ? Object.keys(doc.agents)
          : c.members.flatMap((m) => (doc.teams[m] ? byTeam(m) : doc.agents[m] ? [m] : (() => { throw new OrgError(`channel ${slug}: unknown member ${m}`); })()));
      await setMembers(slug, members);
      channels++;
    }
    return { agents: Object.keys(doc.agents).length, teams: Object.keys(doc.teams).length, channels, retired: retired ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Identity and access
// ---------------------------------------------------------------------------

export async function getAgent(name: string): Promise<Agent> {
  const { rows } = await query<Agent>(
    `SELECT name, team_slug, runtime, role, reports_to, model, expertise, retired_at FROM org_agents WHERE name = $1`,
    [name],
  );
  const a = rows[0];
  if (!a) throw new OrgError(`unknown agent "${name}"; run cli-org agents for the roster`);
  if (a.retired_at) throw new OrgError(`agent "${name}" is retired`);
  return a;
}

export async function isLead(name: string): Promise<boolean> {
  const { rowCount } = await query(`SELECT 1 FROM teams WHERE lead = $1`, [name]);
  return (rowCount ?? 0) > 0;
}

async function channelExists(slug: string): Promise<{ slug: string; kind: string; team_slug: string | null }> {
  const { rows } = await query<{ slug: string; kind: string; team_slug: string | null }>(`SELECT slug, kind, team_slug FROM org_channels WHERE slug = $1`, [slug]);
  if (!rows[0]) throw new OrgError(`no channel #${slug}`);
  return rows[0];
}

/** The channels a caller may read: its memberships, or everything for a human. */
export async function channelsFor(agent: Agent): Promise<string[]> {
  const { rows } =
    agent.runtime === 'human'
      ? await query<{ slug: string }>(`SELECT slug FROM org_channels ORDER BY kind, slug`)
      : await query<{ slug: string }>(
          `SELECT c.slug FROM org_channel_members m JOIN org_channels c ON c.slug = m.channel_slug WHERE m.agent_name = $1 ORDER BY c.kind, c.slug`,
          [agent.name],
        );
  return rows.map((r) => r.slug);
}

async function assertMember(agent: Agent, channel: string, forPost = false): Promise<void> {
  await channelExists(channel);
  if (agent.runtime === 'human') return;
  const { rows } = await query<{ can_post: boolean }>(`SELECT can_post FROM org_channel_members WHERE channel_slug = $1 AND agent_name = $2`, [channel, agent.name]);
  if (!rows[0]) throw new OrgError(`${agent.name} is not a member of #${channel}`);
  if (forPost && !rows[0].can_post) throw new OrgError(`${agent.name} may read but not post in #${channel}`);
}

/** `@name` tokens that are active agents, plus any explicit names, deduplicated. */
export async function resolveMentions(body: string, explicit: string[] = []): Promise<string[]> {
  const found = [...body.matchAll(/(?:^|[^a-z0-9-])@([a-z0-9][a-z0-9-]{0,31})/g)].map((m) => m[1]!);
  const names = [...new Set([...found, ...explicit])];
  if (!names.length) return [];
  const { rows } = await query<{ name: string }>(`SELECT name FROM org_agents WHERE name = ANY ($1) AND retired_at IS NULL`, [names]);
  const ok = new Set(rows.map((r) => r.name));
  for (const n of explicit) if (!ok.has(n)) throw new OrgError(`unknown agent "${n}"`);
  return names.filter((n) => ok.has(n));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ReadOpts {
  channel?: string;
  /** Only messages after the caller's read cursor (default true). */
  unreadOnly?: boolean;
  kinds?: Kind[];
  sinceHours?: number;
  limit?: number;
  /** Advance the read cursor (default true). */
  mark?: boolean;
}

export async function readMessages(agent: Agent, opts: ReadOpts = {}): Promise<Message[]> {
  const channels = opts.channel ? [opts.channel] : await channelsFor(agent);
  if (opts.channel) await assertMember(agent, opts.channel);
  if (!channels.length) return [];
  const unreadOnly = opts.unreadOnly ?? true;
  const params: unknown[] = [agent.name, channels];
  const where: string[] = ['m.channel_slug = ANY ($2)'];
  if (unreadOnly) where.push('m.id > COALESCE(r.last_read_id, 0)', 'm.author <> $1');
  if (opts.kinds?.length) {
    params.push(opts.kinds);
    where.push(`m.kind = ANY ($${params.length})`);
  }
  if (opts.sinceHours) {
    params.push(opts.sinceHours);
    where.push(`m.created_at > now() - make_interval(hours => $${params.length})`);
  }
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 1000));
  const { rows } = await query<Message>(
    `SELECT ${MESSAGE_COLS.split(', ').map((c) => `m.${c}`).join(', ')}
       FROM org_messages m
       LEFT JOIN org_reads r ON r.agent_name = $1 AND r.channel_slug = m.channel_slug
      WHERE ${where.join(' AND ')}
      ORDER BY m.id
      LIMIT $${params.length}`,
    params,
  );
  if (opts.mark ?? true) await markRead(agent, channels, rows);
  return rows;
}

async function markRead(agent: Agent, channels: string[], shown: Message[]): Promise<void> {
  // Advance to the newest message in each channel the caller looked at, not just
  // what fit under the limit, unless the limit cut the list short.
  const perChannel = new Map<string, number>();
  for (const m of shown) perChannel.set(m.channel_slug, Math.max(perChannel.get(m.channel_slug) ?? 0, m.id));
  if (!perChannel.size) return;
  for (const [channel, id] of perChannel) {
    await query(
      `INSERT INTO org_reads (agent_name, channel_slug, last_read_id) VALUES ($1,$2,$3)
       ON CONFLICT (agent_name, channel_slug) DO UPDATE SET last_read_id = GREATEST(org_reads.last_read_id, EXCLUDED.last_read_id), read_at = now()`,
      [agent.name, channel, id],
    );
  }
  void channels;
}

export async function unreadCounts(agent: Agent): Promise<Record<string, number>> {
  const channels = await channelsFor(agent);
  if (!channels.length) return {};
  const { rows } = await query<{ channel_slug: string; n: number }>(
    `SELECT m.channel_slug, count(*)::int AS n
       FROM org_messages m LEFT JOIN org_reads r ON r.agent_name = $1 AND r.channel_slug = m.channel_slug
      WHERE m.channel_slug = ANY ($2) AND m.id > COALESCE(r.last_read_id, 0) AND m.author <> $1
      GROUP BY m.channel_slug`,
    [agent.name, channels],
  );
  return Object.fromEntries(rows.map((r) => [r.channel_slug, r.n]));
}

export async function getThread(agent: Agent, id: number): Promise<Message[]> {
  const { rows } = await query<Message>(`SELECT ${MESSAGE_COLS} FROM org_messages WHERE id = $1`, [id]);
  const root = rows[0];
  if (!root) throw new OrgError(`no message ${id}`);
  await assertMember(agent, root.channel_slug);
  const top = root.thread_id ?? root.id;
  const { rows: all } = await query<Message>(`SELECT ${MESSAGE_COLS} FROM org_messages WHERE id = $1 OR thread_id = $1 ORDER BY id`, [top]);
  return all;
}

export async function searchMessages(agent: Agent, q: string, limit = 50): Promise<Message[]> {
  const channels = await channelsFor(agent);
  if (!channels.length || !q.trim()) return [];
  const { rows } = await query<Message>(
    `SELECT ${MESSAGE_COLS} FROM org_messages
      WHERE channel_slug = ANY ($1) AND tsv @@ plainto_tsquery('simple', $2)
      ORDER BY id DESC LIMIT $3`,
    [channels, q, Math.min(limit, 200)],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface PostOpts {
  kind?: Kind;
  thread?: number;
  task?: string;
  project?: string;
  feature?: string;
  run?: string;
  mentions?: string[];
  urgent?: boolean;
}

async function insertMessage(tx: TxClient, agent: Agent, channel: string, kind: Kind, body: string, opts: PostOpts): Promise<Message> {
  const { rows } = await tx.query<Message>(
    `INSERT INTO org_messages (channel_slug, thread_id, author, kind, body, mentions, urgent, task_id, project_slug, feature_slug, run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${MESSAGE_COLS}`,
    [channel, opts.thread ?? null, agent.name, kind, body, opts.mentions ?? [], opts.urgent ?? false, opts.task ?? null, opts.project ?? null, opts.feature ?? null, opts.run ?? null],
  );
  return rows[0]!;
}

async function checkThread(channel: string, thread: number | undefined): Promise<void> {
  if (thread === undefined) return;
  const { rows } = await query<{ channel_slug: string; thread_id: number | null }>(`SELECT channel_slug, thread_id FROM org_messages WHERE id = $1`, [thread]);
  if (!rows[0]) throw new OrgError(`no message ${thread} to reply to`);
  if (rows[0].channel_slug !== channel) throw new OrgError(`message ${thread} is in #${rows[0].channel_slug}, not #${channel}`);
  if (rows[0].thread_id) throw new OrgError(`message ${thread} is itself a reply; reply to ${rows[0].thread_id}`);
}

/** A plain post in a channel the caller belongs to. */
export async function post(agent: Agent, channel: string, body: string, opts: PostOpts = {}): Promise<Message> {
  const text = Body.parse(body);
  const kind: Kind = opts.kind ?? (opts.thread !== undefined ? 'reply' : 'message');
  if (!(POST_KINDS as readonly string[]).includes(kind)) throw new OrgError(`post can't use kind ${kind}; use the ${kind === 'handoff' ? 'handoff' : kind === 'standup' ? 'standup' : 'ask-owner'} command`);
  await assertMember(agent, channel, true);
  await checkThread(channel, opts.thread);
  const mentions = await resolveMentions(text, opts.mentions);
  if (opts.project) {
    const { rowCount } = await query(`SELECT 1 FROM projects WHERE slug = $1`, [opts.project]);
    if (!rowCount) throw new OrgError(`no project "${opts.project}" in the tracker`);
  }
  return withTransaction((tx) => insertMessage(tx, agent, channel, kind, text, { ...opts, mentions }));
}

export function dmSlug(a: string, b: string): string {
  return `dm:${[a, b].sort().join(':')}`;
}

/** Who may DM whom: a human anyone; same team; two leads. Nobody DMs the human (ask-owner is the path). */
export async function assertDmAllowed(from: Agent, to: Agent): Promise<void> {
  if (from.name === to.name) throw new OrgError('no DMs to yourself');
  if (from.runtime === 'human') return;
  if (to.runtime === 'human') throw new OrgError(`${to.name} is reached through your lead, or with ask-owner if you are a lead`);
  if (from.team_slug && from.team_slug === to.team_slug) return;
  if ((await isLead(from.name)) && (await isLead(to.name))) return;
  throw new OrgError(`${from.name} can't DM ${to.name}: DMs stay inside a team or between leads; use a handoff in a shared channel`);
}

export async function dm(from: Agent, toName: string, body: string, opts: PostOpts = {}): Promise<Message> {
  const text = Body.parse(body);
  const to = await getAgent(toName);
  await assertDmAllowed(from, to);
  const kind: Kind = opts.kind ?? 'message';
  if (!['message', 'handoff', 'reply', 'decision'].includes(kind)) throw new OrgError(`a DM can't be a ${kind}`);
  const slug = dmSlug(from.name, to.name);
  return withTransaction(async (tx) => {
    // SECURITY DEFINER: the one write to channels and memberships an agent makes (the RLS role can't insert them itself).
    await tx.query(`SELECT org_dm_channel($1, $2)`, [from.name, to.name]);
    if (opts.thread !== undefined) await checkThread(slug, opts.thread);
    return insertMessage(tx, from, slug, kind, text, { ...opts, mentions: [to.name] });
  });
}

/** Work handed to a named agent in a shared channel both are in. Wakes the agent, and its lead when the teams differ. */
export async function handoff(from: Agent, channel: string, toName: string, body: string, opts: PostOpts = {}): Promise<Message> {
  const text = Body.parse(body);
  const to = await getAgent(toName);
  const ch = await channelExists(channel);
  if (ch.kind === 'dm') throw new OrgError('a handoff goes in a team or shared channel; use dm for a direct one');
  await assertMember(from, channel, true);
  await assertMember(to, channel).catch(() => {
    throw new OrgError(`${to.name} is not in #${channel}; pick a channel you are both in`);
  });
  const mentions = await resolveMentions(text, [to.name]);
  return withTransaction((tx) => insertMessage(tx, from, channel, 'handoff', text, { ...opts, mentions }));
}

/** Leads only. Lands in #leads for the stand-up; `urgent` also goes to the owner's phone (capped per day). */
export async function askOwner(from: Agent, body: string, opts: { urgent?: boolean; task?: string; project?: string } = {}): Promise<Message> {
  const text = Body.parse(body);
  if (from.runtime === 'human') throw new OrgError('you are the owner');
  if (!(await isLead(from.name))) throw new OrgError(`${from.name} is not a lead; DM your lead (${from.reports_to ?? 'unknown'}) and they can ask`);
  await assertMember(from, 'leads', true);
  if (opts.urgent) {
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM org_messages WHERE author = $1 AND urgent AND created_at > now() - interval '24 hours'`,
      [from.name],
    );
    if ((rows[0]?.n ?? 0) >= URGENT_PER_DAY) throw new OrgError(`${from.name} already sent ${URGENT_PER_DAY} urgent questions today; this one waits for the stand-up`);
  }
  return withTransaction((tx) => insertMessage(tx, from, 'leads', 'question-for-owner', text, { urgent: opts.urgent ?? false, task: opts.task, project: opts.project, mentions: [] }));
}

/** Leads only, once a day, in #<team>-standup. */
export async function standup(from: Agent, body: string): Promise<Message> {
  const text = Body.parse(body);
  if (!from.team_slug || !(await isLead(from.name))) throw new OrgError(`${from.name} is not a team lead; only leads post the stand-up`);
  const channel = `${from.team_slug}-standup`;
  await assertMember(from, channel, true);
  const { rowCount } = await query(
    `SELECT 1 FROM org_messages WHERE author = $1 AND kind = 'standup' AND created_at >= date_trunc('day', now())`,
    [from.name],
  );
  if (rowCount) throw new OrgError(`${from.name} already posted today's stand-up; post a status with what changed instead`);
  return withTransaction((tx) => insertMessage(tx, from, channel, 'standup', text, { mentions: [] }));
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface Whoami {
  agent: Agent;
  team: { slug: string; name: string; lead: string | null } | null;
  is_lead: boolean;
  reports: string[];
  channels: { slug: string; kind: string; unread: number }[];
  wakeups: Wakeup[];
}

export interface Wakeup {
  id: number;
  agent_name: string;
  reason: string;
  ref: string | null;
  created_at: Date;
  claimed_at: Date | null;
  done_at: Date | null;
}

export async function whoami(agent: Agent): Promise<Whoami> {
  const team = agent.team_slug
    ? (await query<{ slug: string; name: string; lead: string | null }>(`SELECT slug, name, lead FROM teams WHERE slug = $1`, [agent.team_slug])).rows[0] ?? null
    : null;
  const { rows: reports } = await query<{ name: string }>(`SELECT name FROM org_agents WHERE reports_to = $1 AND retired_at IS NULL ORDER BY name`, [agent.name]);
  const slugs = await channelsFor(agent);
  const kinds = new Map<string, string>();
  if (slugs.length) {
    const { rows } = await query<{ slug: string; kind: string }>(`SELECT slug, kind FROM org_channels WHERE slug = ANY ($1)`, [slugs]);
    for (const r of rows) kinds.set(r.slug, r.kind);
  }
  const unread = await unreadCounts(agent);
  return {
    agent,
    team,
    is_lead: await isLead(agent.name),
    reports: reports.map((r) => r.name),
    channels: slugs.map((s) => ({ slug: s, kind: kinds.get(s) ?? '?', unread: unread[s] ?? 0 })),
    wakeups: await openWakeups(agent.name),
  };
}

export async function openWakeups(agentName?: string): Promise<Wakeup[]> {
  const { rows } = await query<Wakeup>(
    `SELECT id, agent_name, reason, ref, created_at, claimed_at, done_at FROM org_wakeups
      WHERE done_at IS NULL ${agentName ? 'AND agent_name = $1' : ''} ORDER BY id`,
    agentName ? [agentName] : [],
  );
  return rows;
}

export interface ChartAgent extends Agent {
  team_name: string | null;
  is_lead: boolean;
  session_id: string | null;
  session_started: Date | null;
}

export async function orgChart(): Promise<{ teams: { slug: string; name: string; lead: string | null }[]; agents: ChartAgent[] }> {
  const { rows: teams } = await query<{ slug: string; name: string; lead: string | null }>(
    `SELECT t.slug, t.name, t.lead FROM teams t WHERE EXISTS (SELECT 1 FROM org_agents a WHERE a.team_slug = t.slug AND a.retired_at IS NULL) ORDER BY t.sort, t.slug`,
  );
  const { rows: agents } = await query<ChartAgent>(
    `SELECT a.name, a.team_slug, a.runtime, a.role, a.reports_to, a.model, a.expertise, a.retired_at, t.name AS team_name,
            EXISTS (SELECT 1 FROM teams x WHERE x.lead = a.name) AS is_lead, a.session_id, a.session_started
       FROM org_agents a LEFT JOIN teams t ON t.slug = a.team_slug
      WHERE a.retired_at IS NULL
      ORDER BY (a.runtime = 'human') DESC, t.sort, a.team_slug NULLS FIRST, is_lead DESC, a.name`,
  );
  return { teams, agents };
}

export async function listChannels(agent: Agent): Promise<{ slug: string; kind: string; purpose: string | null; members: number; unread: number }[]> {
  const slugs = await channelsFor(agent);
  if (!slugs.length) return [];
  const { rows } = await query<{ slug: string; kind: string; purpose: string | null; members: number }>(
    `SELECT c.slug, c.kind, c.purpose, (SELECT count(*)::int FROM org_channel_members m WHERE m.channel_slug = c.slug) AS members
       FROM org_channels c WHERE c.slug = ANY ($1) ORDER BY c.kind, c.slug`,
    [slugs],
  );
  const unread = await unreadCounts(agent);
  return rows.map((r) => ({ ...r, unread: unread[r.slug] ?? 0 }));
}

// ---------------------------------------------------------------------------
// Dispatcher side: claim, finish and add wakeups; remember the agent's session
// ---------------------------------------------------------------------------

/** Claims every open, unclaimed wakeup of one agent in one go (one run answers them all). */
export async function claimWakeups(agentName: string, by: string): Promise<Wakeup[]> {
  await getAgent(agentName);
  const { rows } = await query<Wakeup>(
    `UPDATE org_wakeups SET claimed_at = now(), claimed_by = $2
      WHERE id IN (SELECT id FROM org_wakeups WHERE agent_name = $1 AND done_at IS NULL AND claimed_at IS NULL FOR UPDATE SKIP LOCKED)
      RETURNING id, agent_name, reason, ref, created_at, claimed_at, done_at`,
    [agentName, by],
  );
  return rows;
}

/**
 * Marks wakeups done. When the run posted no `status` carrying its run id, the
 * dispatcher's one line goes to the agent's team channel so the board never
 * shows a silent run.
 */
export async function finishWakeups(
  ids: number[],
  opts: { run?: string; exit?: number; result?: string } = {},
): Promise<{ done: number; fallback_posted: boolean }> {
  if (!ids.length) throw new OrgError('wake-done needs at least one wakeup id');
  const { rows } = await query<{ id: number; agent_name: string }>(
    `UPDATE org_wakeups SET done_at = now(), result = $2 WHERE id = ANY ($1) AND done_at IS NULL RETURNING id, agent_name`,
    [ids, opts.result?.slice(0, 2000) ?? null],
  );
  let fallback_posted = false;
  const agentName = rows[0]?.agent_name;
  if (agentName && opts.run) {
    const { rowCount } = await query(`SELECT 1 FROM org_messages WHERE author = $1 AND run_id = $2 AND kind = 'status'`, [agentName, opts.run]);
    if (!rowCount) {
      const agent = await getAgent(agentName);
      if (agent.team_slug) {
        const body = `status: run ended without a report (exit ${opts.exit ?? '?'})${opts.result ? `. Last output: ${opts.result.slice(0, 600)}` : ''}`;
        await withTransaction((tx) => insertMessage(tx, agent, agent.team_slug!, 'status', body, { run: opts.run, mentions: [] }));
        fallback_posted = true;
      }
    }
  }
  return { done: rows.length, fallback_posted };
}

/** A wakeup the trigger doesn't make: a routine from the clock, a kanban task, or the owner's nudge. Null when one is already open. */
export async function addWakeup(agentName: string, reason: 'routine' | 'owner' | 'task', ref: string): Promise<number | null> {
  const agent = await getAgent(agentName);
  if (agent.runtime === 'human') throw new OrgError(`${agentName} is human; nothing wakes the owner`);
  const { rows } = await query<{ id: number }>(
    `INSERT INTO org_wakeups (agent_name, reason, ref) VALUES ($1,$2,$3)
     ON CONFLICT (agent_name, reason, ref) WHERE done_at IS NULL DO NOTHING RETURNING id`,
    [agentName, reason, ref],
  );
  return rows[0]?.id ?? null;
}

export async function setSession(agentName: string, sessionId: string | null): Promise<void> {
  await getAgent(agentName);
  await query(
    `UPDATE org_agents SET session_id = $2, session_started = CASE WHEN $2::text IS NULL THEN NULL ELSE current_date END, updated_at = now() WHERE name = $1`,
    [agentName, sessionId],
  );
}

export async function getSession(agentName: string): Promise<{ session_id: string | null; session_started: Date | null }> {
  await getAgent(agentName);
  const { rows } = await query<{ session_id: string | null; session_started: Date | null }>(`SELECT session_id, session_started FROM org_agents WHERE name = $1`, [agentName]);
  return rows[0]!;
}

/** Un-claims wakeups whose run died with the dispatcher (every claimed, unfinished one at a restart). */
export async function releaseClaimed(): Promise<number> {
  const { rowCount } = await query(`UPDATE org_wakeups SET claimed_at = NULL, claimed_by = NULL WHERE done_at IS NULL AND claimed_at IS NOT NULL`);
  return rowCount ?? 0;
}


// ---------------------------------------------------------------------------
// App views: what /api/org/* reads (as the owner) for the /org page
// ---------------------------------------------------------------------------

export interface PageOpts {
  /** Messages with an id above this (the live cursor). */
  after?: number;
  /** Messages with an id below this (paging back). */
  before?: number;
  limit?: number;
}

/**
 * A page of messages in id order, newest last, never marking anything read:
 * one channel's, or every channel the caller can see when `channel` is
 * omitted (the live feed). Without `after` it is the newest `limit`.
 */
export async function pageMessages(agent: Agent, channel: string | undefined, opts: PageOpts = {}): Promise<Message[]> {
  const channels = channel ? [channel] : await channelsFor(agent);
  if (channel) await assertMember(agent, channel);
  if (!channels.length) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const params: unknown[] = [channels];
  const where = ['channel_slug = ANY ($1)'];
  if (opts.after !== undefined) {
    params.push(opts.after);
    where.push(`id > $${params.length}`);
  }
  if (opts.before !== undefined) {
    params.push(opts.before);
    where.push(`id < $${params.length}`);
  }
  params.push(limit);
  // Newest first under the limit, then flipped: a page always ends at the newest message.
  const { rows } = await query<Message>(
    `SELECT * FROM (SELECT ${MESSAGE_COLS} FROM org_messages WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}) p ORDER BY id`,
    params,
  );
  return rows;
}

/** Moves the caller's read cursor to the newest message in the channel. */
export async function markChannelRead(agent: Agent, channel: string): Promise<void> {
  await assertMember(agent, channel);
  await query(
    `INSERT INTO org_reads (agent_name, channel_slug, last_read_id)
     VALUES ($1, $2, COALESCE((SELECT max(id) FROM org_messages WHERE channel_slug = $2), 0))
     ON CONFLICT (agent_name, channel_slug) DO UPDATE SET last_read_id = GREATEST(org_reads.last_read_id, EXCLUDED.last_read_id), read_at = now()`,
    [agent.name, channel],
  );
}

export interface ChannelMember {
  agent_name: string;
  can_post: boolean;
  role: string;
  team_slug: string | null;
  runtime: string;
}

export async function channelMembers(agent: Agent, channel: string): Promise<ChannelMember[]> {
  await assertMember(agent, channel);
  const { rows } = await query<ChannelMember>(
    `SELECT m.agent_name, m.can_post, a.role, a.team_slug, a.runtime
       FROM org_channel_members m JOIN org_agents a ON a.name = m.agent_name
      WHERE m.channel_slug = $1 AND a.retired_at IS NULL
      ORDER BY (a.runtime = 'human') DESC, a.team_slug NULLS FIRST, m.agent_name`,
    [channel],
  );
  return rows;
}

export interface AgentActivity {
  /** When the agent's last wake finished (or was claimed), null if it never ran. */
  last_wake: Date | null;
  /** Wakeups created since local midnight (server clock), done or not. */
  wakes_today: number;
  open_wakeups: number;
  /** Messages in the agent's channels it has not read. */
  unread: number;
  /** Its newest message of any kind. */
  last_post: Date | null;
}

/** One pass over the wakeups and read cursors for the whole chart. */
export async function agentActivity(): Promise<Record<string, AgentActivity>> {
  const { rows } = await query<{ name: string } & AgentActivity>(
    `SELECT a.name,
            (SELECT max(COALESCE(w.done_at, w.claimed_at)) FROM org_wakeups w WHERE w.agent_name = a.name) AS last_wake,
            (SELECT count(*)::int FROM org_wakeups w WHERE w.agent_name = a.name AND w.created_at >= date_trunc('day', now())) AS wakes_today,
            (SELECT count(*)::int FROM org_wakeups w WHERE w.agent_name = a.name AND w.done_at IS NULL) AS open_wakeups,
            (SELECT count(*)::int FROM org_channel_members cm
               JOIN org_messages m ON m.channel_slug = cm.channel_slug AND m.author <> a.name
               LEFT JOIN org_reads r ON r.agent_name = a.name AND r.channel_slug = cm.channel_slug
              WHERE cm.agent_name = a.name AND m.id > COALESCE(r.last_read_id, 0)) AS unread,
            (SELECT max(m.created_at) FROM org_messages m WHERE m.author = a.name) AS last_post
       FROM org_agents a WHERE a.retired_at IS NULL`,
  );
  return Object.fromEntries(rows.map(({ name, ...rest }) => [name, rest]));
}

export interface Run extends Wakeup {
  claimed_by: string | null;
  result: string | null;
}

/** The agent's newest wakeups, finished or not: what the app shows as its runs. */
export async function agentRuns(name: string, limit = 20): Promise<Run[]> {
  const { rows } = await query<Run>(
    `SELECT id, agent_name, reason, ref, created_at, claimed_at, done_at, claimed_by, result
       FROM org_wakeups WHERE agent_name = $1 ORDER BY id DESC LIMIT $2`,
    [name, Math.min(Math.max(limit, 1), 200)],
  );
  return rows;
}

/** The newest messages an agent wrote, in the channels the caller can see. */
export async function messagesBy(agent: Agent, author: string, limit = 20): Promise<Message[]> {
  const channels = await channelsFor(agent);
  if (!channels.length) return [];
  const { rows } = await query<Message>(
    `SELECT ${MESSAGE_COLS} FROM org_messages WHERE author = $1 AND channel_slug = ANY ($2) ORDER BY id DESC LIMIT $3`,
    [author, channels, Math.min(Math.max(limit, 1), 200)],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// The work graph: kanban cards for bots, tagged with a tracker project and
// feature (task_links); graph templates; the review loop.
// Design: agent-company/work-graph-plan.md.
// ---------------------------------------------------------------------------

export interface TaskLink {
  task_id: string;
  board: string;
  title: string;
  project_slug: string | null;
  feature_slug: string | null;
  assignee: string;
  created_by: string;
  rounds: number;
  graph: string | null;
  node: string | null;
  kind: string;
  work_type: string | null;
  created_at: Date;
}

export const WORK_TYPES = ['research', 'coding', 'design', 'media', 'writing', 'sales', 'education', 'ops'] as const;
export type WorkType = (typeof WORK_TYPES)[number];
function checkWorkType(t: string | undefined): WorkType | null {
  if (t === undefined) return null;
  if (!(WORK_TYPES as readonly string[]).includes(t)) throw new OrgError(`--type ${t}: one of ${WORK_TYPES.join(', ')}`);
  return t as WorkType;
}

/** Runs `hermes kanban …` and returns stdout; injected so tests never need the binary. */
export type KanbanRunner = (args: string[]) => Promise<string>;

export const DEFAULT_BOARD = 'exo';
export const MAX_ROUNDS = 2;
const CARD_ID = /^t_[0-9a-f]{6,32}$/;
const BOARD_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Who may give whom a card: a human anyone on the roster; a lead its own team; a member only itself. */
export async function assertMayAssign(caller: Agent, to: Agent): Promise<void> {
  if (to.runtime === 'human') throw new OrgError(`${to.name} is not a bot; cards go to bots on the roster`);
  if (caller.runtime === 'human' || caller.name === to.name) return;
  if (caller.team_slug && caller.team_slug === to.team_slug && (await isLead(caller.name))) return;
  throw new OrgError(`${caller.name} can't give ${to.name} a card: a lead assigns inside its team, a member only to itself; ask your lead or hand off on the board`);
}

async function assertProject(project: string, feature?: string): Promise<{ title: string; team_slug: string | null }> {
  const { rows } = await query<{ title: string; team_slug: string | null }>(`SELECT title, team_slug FROM projects WHERE slug = $1`, [project]);
  if (!rows[0]) throw new OrgError(`no project "${project}" in the tracker (cli-projects list)`);
  if (feature) {
    const { rows: f } = await query<{ title: string }>(`SELECT title FROM features WHERE project_slug = $1 AND slug = $2`, [project, feature]);
    if (!f[0]) throw new OrgError(`no feature "${project}/${feature}" in the tracker`);
    return { title: f[0].title, team_slug: rows[0].team_slug };
  }
  return rows[0];
}

interface CardSpec {
  title: string;
  body?: string;
  project: string;
  feature?: string;
  board?: string;
  priority?: number;
  parents?: string[];
  graph?: string;
  node?: string;
  kind?: string;
  rounds?: number;
  work?: string;
  extra?: string;
}

function cardHeader(caller: Agent, to: Agent, c: CardSpec): string {
  const ref = `${c.project}${c.feature ? `/${c.feature}` : ''}`;
  const channel = to.team_slug ?? 'all-hands';
  const lines = [
    `Project: ${ref}`,
    `Assigned by ${caller.name}.${c.graph ? ` Graph ${c.graph}, node ${c.node}${c.kind && c.kind !== 'work' ? ` (${c.kind})` : ''}.` : ''}${c.rounds ? ` Round ${c.rounds}.` : ''}`,
    `When done: cli-org post ${channel} "<what changed, with a path or command>" --kind status --task <this card> --project ${c.project}${c.feature ? ` --feature ${c.feature}` : ''}, then hermes kanban complete <this card>. Blocked: hermes kanban block <this card> "<why>" and tell your lead.`,
  ];
  if (c.extra) lines.push(c.extra);
  return lines.join('\n');
}

/** The one path that makes a kanban card for a bot and records its link; every verb goes through it. */
async function createCard(caller: Agent, to: Agent, c: CardSpec, run: KanbanRunner): Promise<{ task_id: string; link: TaskLink }> {
  const title = c.title.trim().replace(/\s+/g, ' ');
  if (!title || title.length > 200) throw new OrgError('a card title is 1 to 200 characters');
  if ((c.body ?? '').length > 6000) throw new OrgError('a card body is at most 6000 characters');
  const board = c.board ?? DEFAULT_BOARD;
  if (!BOARD_RE.test(board)) throw new OrgError(`bad board name "${board}"`);
  const body = c.body?.trim() ? `${cardHeader(caller, to, c)}\n\n${c.body.trim()}` : cardHeader(caller, to, c);
  const args = ['kanban', '--board', board, 'create', `--body=${body}`, '--assignee', to.name, '--created-by', caller.name, '--json'];
  if (c.priority !== undefined) args.push('--priority', String(c.priority));
  for (const parent of c.parents ?? []) args.push('--parent', parent);
  args.push('--', title);
  const out = await run(args);
  let id: string | undefined;
  try {
    const doc = JSON.parse(out) as { id?: string; task?: { id?: string } };
    id = doc.id ?? doc.task?.id;
  } catch {
    /* fall through */
  }
  if (!id || !CARD_ID.test(id)) throw new OrgError(`kanban create returned no card id: ${out.trim().slice(0, 200)}`);
  await query(`SELECT org_task_link($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [
    id, board, title, c.project, c.feature ?? null, to.name, caller.name, c.graph ?? null, c.node ?? null, c.kind ?? 'work', c.rounds ?? 0,
    checkWorkType(c.work),
  ]);
  const { rows } = await query<TaskLink>(`SELECT * FROM task_links WHERE task_id = $1`, [id]);
  return { task_id: id, link: rows[0]! };
}

export interface CreateTaskOpts {
  assignee: string;
  title: string;
  body?: string;
  project: string;
  feature?: string;
  board?: string;
  priority?: number;
  /** research | coding | design | media | writing | sales | education | ops; else the bot's default on /usage. */
  type?: string;
  run?: string;
}

/**
 * One card, one bot, one project. Creates the kanban card, records the link
 * (and the feature's owner) through org_task_link(), and, when someone else
 * gave the card, posts a mention in the bot's team channel so the board
 * carries the conversation. The dispatcher sees the card as `ready` on its
 * next tick and wakes the bot with it.
 */
export async function createTask(caller: Agent, opts: CreateTaskOpts, run: KanbanRunner): Promise<{ task_id: string; link: TaskLink; message: Message | null }> {
  const to = await getAgent(opts.assignee);
  await assertMayAssign(caller, to);
  await assertProject(opts.project, opts.feature);
  const { task_id, link } = await createCard(caller, to, { ...opts, work: opts.type }, run);
  const message = await mentionCard(caller, to, link, opts.run);
  return { task_id, link, message };
}

/** The mention in the bot's team channel that makes the board carry the card. Nothing when a bot gives itself a card. */
async function mentionCard(caller: Agent, to: Agent, link: TaskLink, run?: string): Promise<Message | null> {
  if (caller.name === to.name || !to.team_slug) return null;
  const ref = `${link.project_slug}${link.feature_slug ? `/${link.feature_slug}` : ''}`;
  // A mention, not a handoff: a handoff from outside the team also wakes the lead, and a card needs only its bot.
  return post(caller, to.team_slug, `@${to.name} card ${link.task_id}: ${link.title} (${ref})`, { task: link.task_id, project: link.project_slug ?? undefined, feature: link.feature_slug ?? undefined, run });
}

export interface AssignTaskOpts {
  taskId: string;
  assignee: string;
  project: string;
  feature?: string;
  board?: string;
  type?: string;
  run?: string;
}

/**
 * An existing kanban card (one the owner or a Hermes session made, or an unassigned one on the board)
 * becomes a bot's card: the kanban assignee moves, the link row and the feature's owner are written
 * through org_task_link(), the closing commands go in a comment (an open card's body can't be edited),
 * and the bot is mentioned in its team channel. The card keeps its status, so a `todo` card still waits
 * for its parents and a `ready` one wakes the bot on the dispatcher's next tick.
 */
export async function assignTask(caller: Agent, opts: AssignTaskOpts, run: KanbanRunner): Promise<{ task_id: string; link: TaskLink; message: Message | null }> {
  if (!CARD_ID.test(opts.taskId)) throw new OrgError(`bad card id "${opts.taskId}"`);
  const board = opts.board ?? DEFAULT_BOARD;
  if (!BOARD_RE.test(board)) throw new OrgError(`bad board name "${board}"`);
  const to = await getAgent(opts.assignee);
  await assertMayAssign(caller, to);
  await assertProject(opts.project, opts.feature);
  let card: { title?: string; status?: string } = {};
  try {
    const doc = JSON.parse(await run(['kanban', '--board', board, 'show', opts.taskId, '--json'])) as { task?: typeof card } & typeof card;
    card = doc.task ?? doc;
  } catch {
    /* fall through */
  }
  const title = String(card.title ?? '').trim().replace(/\s+/g, ' ');
  const status = String(card.status ?? '');
  if (!title) throw new OrgError(`no card ${opts.taskId} on board ${board} (hermes kanban --board ${board} show ${opts.taskId})`);
  if (status === 'done' || status === 'archived') throw new OrgError(`card ${opts.taskId} is ${status}; give ${to.name} a new card instead`);
  if (status === 'running') throw new OrgError(`card ${opts.taskId} is running; wait for the worker or reclaim it first`);
  await run(['kanban', '--board', board, 'assign', opts.taskId, to.name]);
  await run(['kanban', '--board', board, 'comment', '--author', caller.name, '--', opts.taskId, cardHeader(caller, to, { title, project: opts.project, feature: opts.feature, board })]);
  await query(`SELECT org_task_link($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`, [
    opts.taskId, board, title, opts.project, opts.feature ?? null, to.name, caller.name, null, null, 'work', 0, checkWorkType(opts.type),
  ]);
  const { rows } = await query<TaskLink>(`SELECT * FROM task_links WHERE task_id = $1`, [opts.taskId]);
  const link = rows[0]!;
  const message = await mentionCard(caller, to, link, opts.run);
  return { task_id: opts.taskId, link, message };
}

export interface TaskFilter {
  project?: string;
  feature?: string;
  agent?: string;
  limit?: number;
}

export async function listTasks(f: TaskFilter = {}): Promise<TaskLink[]> {
  const { rows } = await query<TaskLink>(
    `SELECT * FROM task_links
      WHERE ($1::text IS NULL OR project_slug = $1) AND ($2::text IS NULL OR feature_slug = $2) AND ($3::text IS NULL OR assignee = $3)
      ORDER BY created_at DESC, task_id LIMIT $4`,
    [f.project ?? null, f.feature ?? null, f.agent ?? null, Math.min(f.limit ?? 200, 1000)],
  );
  return rows;
}

// ---- graph templates --------------------------------------------------------

export interface GraphNode {
  id: string;
  assign: string;
  title: string;
  body?: string;
  after: string[];
  kind: string;
  work?: string;
  priority?: number;
}

export interface GraphTemplate {
  name: string;
  description?: string;
  /** The kind of work every card of the template counts as (usage attribution); a node's `work` overrides it. */
  work?: string;
  nodes: GraphNode[];
}

/** The compiled templates (`compile.py graphs` → .agents/org/graphs.json). Empty when the vault has none. */
export function loadGraphs(vaultRoot: string): Record<string, GraphTemplate> {
  try {
    const doc = JSON.parse(readFileSync(join(vaultRoot, '.agents', 'org', 'graphs.json'), 'utf8')) as { graphs?: Record<string, GraphTemplate> };
    return doc.graphs ?? {};
  } catch {
    return {};
  }
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(title|project|feature)\}/g, (_, k: string) => vars[k] ?? '');
}

/** `lead`, `role:<word>` (a member of the team whose role contains it; the lead when none does) or a name. */
export async function resolveAssignee(spec: string, team: string | null, lead: string | null): Promise<string> {
  if (spec === 'lead') {
    if (!lead) throw new OrgError(`the team ${team ?? '(none)'} has no lead to assign to`);
    return lead;
  }
  if (spec.startsWith('role:')) {
    const word = spec.slice(5).trim();
    if (!team) throw new OrgError(`role:${word} needs a team: the project has none, pass --team`);
    const { rows } = await query<{ name: string }>(
      `SELECT name FROM org_agents WHERE team_slug = $1 AND retired_at IS NULL AND runtime <> 'human' AND (role ILIKE $2 OR expertise ILIKE $2)
        ORDER BY (name = $3), name`,
      [team, `%${word}%`, lead],
    );
    if (rows[0]) return rows[0].name;
    if (lead) return lead;
    throw new OrgError(`nobody on ${team} matches role:${word} and the team has no lead`);
  }
  return (await getAgent(spec)).name;
}

export interface ApplyOpts {
  project: string;
  feature?: string;
  team?: string;
  board?: string;
  dryRun?: boolean;
  run?: string;
}

export interface PlannedCard {
  node: string;
  kind: string;
  assignee: string;
  title: string;
  after: string[];
  task_id: string | null;
}

/**
 * Applies a template for one project (and feature): one card per node, in
 * file order, each with its parents already created so the kanban keeps it in
 * todo until they finish. Only the root nodes' bots are mentioned; the rest
 * are woken by the dispatcher when their card becomes ready.
 */
export async function applyGraph(caller: Agent, template: GraphTemplate, opts: ApplyOpts, run: KanbanRunner): Promise<{ cards: PlannedCard[]; message: Message | null }> {
  const target = await assertProject(opts.project, opts.feature);
  const team = opts.team ?? target.team_slug;
  const lead = team ? ((await query<{ lead: string | null }>(`SELECT lead FROM teams WHERE slug = $1`, [team])).rows[0]?.lead ?? null) : null;
  const vars = { title: target.title, project: opts.project, feature: opts.feature ?? '' };
  const planned: PlannedCard[] = [];
  const agents = new Map<string, Agent>();
  for (const n of template.nodes) {
    const name = await resolveAssignee(n.assign, team, lead);
    const to = agents.get(name) ?? (await getAgent(name));
    agents.set(name, to);
    await assertMayAssign(caller, to);
    for (const a of n.after) if (!planned.some((p) => p.node === a)) throw new OrgError(`graph ${template.name}: node ${n.id} is after unknown node ${a}`);
    planned.push({ node: n.id, kind: n.kind, assignee: name, title: fill(n.title, vars), after: n.after, task_id: null });
  }
  if (opts.dryRun) return { cards: planned, message: null };
  const ids = new Map<string, string>();
  for (const [i, n] of template.nodes.entries()) {
    const card = planned[i]!;
    const { task_id } = await createCard(caller, agents.get(card.assignee)!, {
      title: card.title,
      body: n.body ? fill(n.body, vars) : undefined,
      project: opts.project,
      feature: opts.feature,
      board: opts.board,
      priority: n.priority,
      parents: n.after.map((a) => ids.get(a)!),
      graph: template.name,
      node: n.id,
      kind: n.kind,
      work: n.work ?? template.work,
      extra: n.after.length ? `After: ${n.after.map((a) => `${a} ${ids.get(a)}`).join(', ')}.` : undefined,
    }, run);
    ids.set(n.id, task_id);
    card.task_id = task_id;
  }
  const roots = [...new Set(planned.filter((c) => !c.after.length && c.assignee !== caller.name).map((c) => c.assignee))];
  const chain = planned.map((c) => `${c.node} ${c.task_id} (${c.assignee})`).join(' → ');
  let message: Message | null = null;
  const channel = team ?? 'all-hands';
  if (caller.runtime === 'human' || caller.team_slug === channel) {
    message = await post(caller, channel, `${roots.map((r) => `@${r}`).join(' ')}${roots.length ? ' ' : ''}graph ${template.name} for ${opts.project}${opts.feature ? `/${opts.feature}` : ''}: ${chain}`, {
      project: opts.project, feature: opts.feature, run: opts.run, task: planned[0]?.task_id ?? undefined,
    });
  }
  return { cards: planned, message };
}

// ---- the review loop ----------------------------------------------------------

async function linkOf(taskId: string): Promise<TaskLink> {
  if (!CARD_ID.test(taskId)) throw new OrgError(`bad card id "${taskId}"`);
  const { rows } = await query<TaskLink>(`SELECT * FROM task_links WHERE task_id = $1`, [taskId]);
  if (!rows[0]) throw new OrgError(`card ${taskId} is not a bot's card (no link row)`);
  return rows[0];
}

/**
 * Changes requested on a review card: a new round of the reviewed card for its
 * builder, linked as a parent of the review card, which is parked with a
 * `dependency` block (the kanban promotes it again when the round is done).
 * After MAX_ROUNDS the lead is told instead and the review card stays blocked.
 */
export async function redoTask(caller: Agent, reviewId: string, changes: string, run: KanbanRunner, runId?: string): Promise<{ escalated: boolean; task_id: string | null; rounds: number; message: Message | null }> {
  const text = Body.parse(changes);
  const review = await linkOf(reviewId);
  const reviewer = await getAgent(review.assignee);
  if (caller.runtime !== 'human' && caller.name !== review.assignee) await assertMayAssign(caller, reviewer);
  const shown = await run(['kanban', '--board', review.board, 'show', reviewId, '--json']);
  let parents: string[] = [];
  try {
    const doc = JSON.parse(shown) as { parents?: string[] };
    parents = doc.parents ?? [];
  } catch {
    throw new OrgError(`kanban show returned no JSON for ${reviewId}`);
  }
  const { rows: candidates } = await query<TaskLink>(`SELECT * FROM task_links WHERE task_id = ANY ($1) ORDER BY rounds DESC, created_at DESC`, [parents]);
  const reviewed = candidates.find((c) => c.kind !== 'review') ?? candidates[0];
  if (!reviewed) throw new OrgError(`card ${reviewId} reviews nothing: it has no parent card with a link row`);
  const builder = await getAgent(reviewed.assignee);
  const rounds = reviewed.rounds + 1;
  const team = builder.team_slug ?? reviewer.team_slug;
  const lead = team ? ((await query<{ lead: string | null }>(`SELECT lead FROM teams WHERE slug = $1`, [team])).rows[0]?.lead ?? null) : null;
  if (rounds > MAX_ROUNDS) {
    await run(['kanban', '--board', review.board, 'comment', '--author', caller.name, '--', reviewId, `Round ${rounds} refused: ${MAX_ROUNDS} rounds are the limit. Escalated to ${lead ?? 'the lead'}. Changes asked: ${text}`]);
    let message: Message | null = null;
    if (lead && lead !== caller.name) message = await dm(caller, lead, `Card ${reviewId} (${reviewed.title}) failed review ${rounds - 1} times; it needs you. Last changes asked: ${text}`, { task: reviewId, run: runId });
    else if (team) message = await post(caller, team, `Card ${reviewId} (${reviewed.title}) failed review ${rounds - 1} times; escalated. Last changes asked: ${text}`, { task: reviewId, project: review.project_slug ?? undefined, feature: review.feature_slug ?? undefined, run: runId });
    return { escalated: true, task_id: null, rounds, message };
  }
  const baseTitle = reviewed.title.replace(/ \(round \d+\)$/, '');
  const { task_id } = await createCard(caller, builder, {
    title: `${baseTitle} (round ${rounds})`,
    body: `Changes requested by ${caller.name} on ${reviewId}:\n${text}`,
    project: reviewed.project_slug ?? review.project_slug ?? '',
    feature: reviewed.feature_slug ?? review.feature_slug ?? undefined,
    board: reviewed.board,
    graph: reviewed.graph ?? undefined,
    node: reviewed.node ?? undefined,
    kind: reviewed.kind,
    rounds,
    work: reviewed.work_type ?? undefined,
    extra: `Review card: ${reviewId} (it reopens when this round is done).`,
  }, run);
  await run(['kanban', '--board', review.board, 'link', task_id, reviewId]);
  await run(['kanban', '--board', review.board, 'block', '--kind', 'dependency', reviewId, `changes requested (round ${rounds}); waits for ${task_id}`]);
  await query(`SELECT org_task_link($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [
    reviewId, review.board, review.title, review.project_slug, review.feature_slug, review.assignee, review.created_by, review.graph, review.node, review.kind, rounds,
  ]);
  let message: Message | null = null;
  if (team && (caller.runtime === 'human' || caller.team_slug === team)) {
    message = await post(caller, team, `@${builder.name} round ${rounds} of ${baseTitle}: card ${task_id}. ${text.slice(0, 300)}`, { task: task_id, project: reviewed.project_slug ?? undefined, feature: reviewed.feature_slug ?? undefined, run: runId });
  }
  return { escalated: false, task_id, rounds, message };
}
