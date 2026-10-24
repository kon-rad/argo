import { z } from 'zod';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { query, withTransaction, type TxClient } from './db.js';
import { assignCard, BoardError, commentCard, createCard, flagCard, linkCards, moveCard, type Card, type Contract } from './board.js';

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

export const KINDS = ['message', 'status', 'decision', 'handoff', 'question-for-owner', 'standup', 'reflection', 'reply', 'ack'] as const;
export type Kind = (typeof KINDS)[number];
/** Kinds a plain `post` may use; the others have their own commands with their own rules. */
/** `ack` is "read, nothing to do": it wakes nobody, so two bots cannot wake each other with acknowledgements. */
export const POST_KINDS = ['message', 'status', 'decision', 'reflection', 'reply', 'ack'] as const;
export const URGENT_PER_DAY = 3;

const Name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'lowercase letters, digits and dashes');
const Body = z.string().trim().min(1).max(8000);

/** A roster routine: `at` is HH:MM in ORG_TZ; `days` are ISO weekdays (1 Monday .. 7 Sunday), all when absent. */
export const Routine = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'lowercase letters, digits and dashes'),
  at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM'),
  days: z.array(z.number().int().min(1).max(7)).optional(),
  /** Vault-relative file whose text is the run's task. */
  task_file: z.string().min(1),
});
export type RoutineT = z.infer<typeof Routine>;

export const OrgDoc = z.object({
  version: z.string().min(1),
  company: z.string().min(1),
  ceo: Name,
  agents: z.record(
    Name,
    z.object({
      runtime: z.enum(['claude-code', 'hermes', 'codex', 'zen-agent', 'human']).default('claude-code'),
      role: z.string().min(1),
      /** A lane (a Claude Code dispatcher lane, a Hermes profile): a roster row cards can name, with no team and no manager. */
      lane: z.boolean().optional(),
      team: Name.optional(),
      reports_to: Name.optional(),
      model: z.string().optional(),
      expertise: z.string().optional(),
      work: z.enum(['research', 'coding', 'design', 'media', 'writing', 'sales', 'education', 'ops']).optional(),
      capabilities: z.array(z.enum(['code', 'review', 'merge', 'deploy', 'm1', 'web', 'dispatch'])).optional(),
      channels: z.array(z.string()).optional(),
      /** Scheduled wakes the engine's dispatcher adds as `routine` wakeups, once per local day (ORG_TZ). */
      routines: z.array(Routine).optional(),
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
  /** What the bot may do beyond the board (code, review, merge, deploy, m1, web); the wrappers read this. */
  capabilities: string[];
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
    if (a.runtime === 'human' || a.lane) continue;
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
        `INSERT INTO org_agents (name, team_slug, runtime, role, model, expertise, org_version, work, capabilities, routines)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT (name) DO UPDATE SET team_slug = EXCLUDED.team_slug, runtime = EXCLUDED.runtime, role = EXCLUDED.role,
           model = EXCLUDED.model, expertise = EXCLUDED.expertise, org_version = EXCLUDED.org_version, work = EXCLUDED.work,
           capabilities = EXCLUDED.capabilities, routines = EXCLUDED.routines, retired_at = NULL, updated_at = now()`,
        [name, a.team ?? null, a.runtime, a.role, a.model ?? null, a.expertise ?? null, doc.version, a.work ?? null, [...new Set(a.capabilities ?? [])],
          JSON.stringify(a.routines ?? [])],
      );
    }
    for (const [name, a] of Object.entries(doc.agents)) {
      await tx.query(`UPDATE org_agents SET reports_to = $2 WHERE name = $1`, [name, a.reports_to ?? null]);
    }
    // The vault session is a roster row too (runtime session), so cards for it have a foreign key; it is never retired.
    await tx.query(
      `INSERT INTO org_agents (name, runtime, role, reports_to, expertise, org_version) VALUES ($1, 'session', $2, $3, 'vault code: skills, scripts, hooks, notes', $4)
       ON CONFLICT (name) DO UPDATE SET runtime = 'session', role = EXCLUDED.role, reports_to = EXCLUDED.reports_to, org_version = EXCLUDED.org_version, retired_at = NULL, updated_at = now()`,
      [config.orgVaultAssignee, VAULT_ROLE, doc.ceo, doc.version],
    );
    const { rowCount: retired } = await tx.query(
      `UPDATE org_agents SET retired_at = now(), updated_at = now() WHERE retired_at IS NULL AND runtime <> 'session' AND NOT (name = ANY ($1))`,
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
    `SELECT name, team_slug, runtime, role, reports_to, model, expertise, capabilities, retired_at FROM org_agents WHERE name = $1`,
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
  if (!['message', 'handoff', 'reply', 'status', 'decision', 'ack'].includes(kind)) throw new OrgError(`a DM can't be a ${kind}`);
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
): Promise<{ done: number; fallback_posted: boolean; agent: string | null; wakeups: { id: number; reason: string; ref: string | null }[] }> {
  if (!ids.length) throw new OrgError('wake-done needs at least one wakeup id');
  const { rows } = await query<{ id: number; agent_name: string; reason: string; ref: string | null }>(
    `UPDATE org_wakeups SET done_at = now(), result = $2 WHERE id = ANY ($1) AND done_at IS NULL RETURNING id, agent_name, reason, ref`,
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
  return { done: rows.length, fallback_posted, agent: agentName ?? null, wakeups: rows.map((r) => ({ id: r.id, reason: r.reason, ref: r.ref })) };
}

/**
 * A wakeup the trigger doesn't make: a routine from the clock, a kanban task, or the owner's nudge. Null when one
 * is already open, or when a card wake is held (taskWakeHold): a card that keeps waking its bot without finishing
 * waits longer each time, and after ORG_TASK_WAKE_RETRIES re-wakes in 24 h it waits for a person. The first time a
 * card is held for good, the bot's team channel gets one status saying so.
 */
export async function addWakeup(agentName: string, reason: 'routine' | 'owner' | 'task', ref: string): Promise<number | null> {
  const agent = await getAgent(agentName);
  if (agent.runtime === 'human') throw new OrgError(`${agentName} is human; nothing wakes the owner`);
  if (reason === 'task') {
    const hold = await taskWakeHold(agentName, ref);
    if (hold) {
      if (hold.reason === 'cap') await postHeld(agent, ref, hold.runs);
      return null;
    }
  }
  if (reason === 'routine' && (await routineRanToday(agentName, ref))) return null;
  const { rows } = await query<{ id: number }>(
    `INSERT INTO org_wakeups (agent_name, reason, ref) VALUES ($1,$2,$3)
     ON CONFLICT (agent_name, reason, ref) WHERE done_at IS NULL DO NOTHING RETURNING id`,
    [agentName, reason, ref],
  );
  return rows[0]?.id ?? null;
}

/**
 * One routine per local day: a routine wakeup already created today in ORG_TZ (open or done) means the next
 * one waits for tomorrow. Judged in the zone the routine is scheduled in, so a run just after midnight UTC
 * and one the same evening are not two days.
 */
export async function routineRanToday(agentName: string, ref: string, tz = config.orgTz): Promise<boolean> {
  const { rowCount } = await query(
    `SELECT 1 FROM org_wakeups WHERE agent_name = $1 AND reason = 'routine' AND ref = $2
       AND (created_at AT TIME ZONE $3)::date = (now() AT TIME ZONE $3)::date LIMIT 1`,
    [agentName, ref, tz],
  );
  return (rowCount ?? 0) > 0;
}

export interface WakeHold {
  /** `backoff`: wait until `until`. `cap`: re-woken too often; only a person (an `owner` wake) moves it now. */
  reason: 'backoff' | 'cap';
  /** Finished wakes of this bot for this card in the last 24 h. */
  runs: number;
  until: Date | null;
}

/** Why a card wake for this bot must wait, or null when it may run now. Every run of a card reloads its context. */
export async function taskWakeHold(agentName: string, ref: string): Promise<WakeHold | null> {
  const { rows } = await query<{ runs: number; last: Date | null }>(
    `SELECT count(*)::int AS runs, max(done_at) AS last FROM org_wakeups
      WHERE agent_name = $1 AND reason = 'task' AND ref = $2 AND done_at > now() - interval '24 hours'`,
    [agentName, ref],
  );
  const { runs, last } = rows[0]!;
  if (!runs || !last) return null;
  if (runs > config.orgTaskWakeRetries) return { reason: 'cap', runs, until: null };
  const until = new Date(last.getTime() + config.orgTaskWakeBackoffMinutes * 60_000 * 2 ** (runs - 1));
  return until.getTime() > Date.now() ? { reason: 'backoff', runs, until } : null;
}

const HELD_PREFIX = 'held: ';

async function postHeld(agent: Agent, ref: string, runs: number): Promise<void> {
  if (!agent.team_slug) return;
  const { rowCount } = await query(
    `SELECT 1 FROM org_messages WHERE author = $1 AND task_id = $2 AND kind = 'status' AND body LIKE $3 AND created_at > now() - interval '24 hours'`,
    [agent.name, ref, `${HELD_PREFIX}%`],
  );
  if (rowCount) return;
  const body = `${HELD_PREFIX}card ${ref} woke ${agent.name} ${runs} times in 24 h without finishing; no more wakes for it until a person looks (an owner wake still runs)`;
  await withTransaction((tx) => insertMessage(tx, agent, agent.team_slug!, 'status', body, { task: ref, mentions: [] }));
}

export interface Session {
  session_id: string | null;
  session_started: Date | null;
  /** Runs the session has carried; at ORG_SESSION_MAX_RUNS it is dropped and the next wake starts fresh. */
  session_runs: number;
}

/**
 * Remembers the session a run used (null forgets it). Each set counts one more run on the stored session; the run
 * that reaches ORG_SESSION_MAX_RUNS drops it, so no session is resumed forever: a resumed `claude -p` sends the
 * whole conversation again on every turn.
 */
export async function setSession(agentName: string, sessionId: string | null): Promise<Session> {
  const cur = await getSession(agentName);
  const runs = sessionId === null ? 0 : cur.session_id ? cur.session_runs + 1 : 1;
  const keep = sessionId !== null && runs < config.orgSessionMaxRuns;
  await query(
    `UPDATE org_agents SET session_id = $2, session_started = CASE WHEN $2::text IS NULL THEN NULL ELSE current_date END,
            session_runs = $3, updated_at = now() WHERE name = $1`,
    [agentName, keep ? sessionId : null, keep ? runs : 0],
  );
  return getSession(agentName);
}

export async function getSession(agentName: string): Promise<Session> {
  await getAgent(agentName);
  const { rows } = await query<Session>(`SELECT session_id, session_started, session_runs FROM org_agents WHERE name = $1`, [agentName]);
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

/** A card for a bot as the older callers knew it (the task_links view): the same row, the old names. */
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
  ship_now: boolean;
  needs: string | null;
  created_at: Date;
}

export function linkOfCard(c: Card): TaskLink {
  return {
    task_id: c.id, board: c.board_slug, title: c.title, project_slug: c.project_slug, feature_slug: c.feature_slug, assignee: c.assignee ?? '', created_by: c.created_by,
    rounds: c.rounds, graph: c.graph, node: c.node, kind: c.kind, work_type: c.work_type, ship_now: c.ship_now, needs: c.needs, created_at: c.created_at,
  };
}

export const WORK_TYPES = ['research', 'coding', 'design', 'media', 'writing', 'sales', 'education', 'ops'] as const;
export type WorkType = (typeof WORK_TYPES)[number];
function checkWorkType(t: string | undefined): WorkType | null {
  if (t === undefined) return null;
  if (!(WORK_TYPES as readonly string[]).includes(t)) throw new OrgError(`--type ${t}: one of ${WORK_TYPES.join(', ')}`);
  return t as WorkType;
}

export const CAPABILITIES = ['code', 'review', 'merge', 'deploy', 'm1', 'web', 'dispatch'] as const;
export type Capability = (typeof CAPABILITIES)[number];
/** What a card can need. `dispatch` (give any card to any bot: the chief of staff's sweep) is a power, not a need. */
const CARD_NEEDS: readonly Capability[] = ['code', 'review', 'merge', 'deploy', 'm1', 'web'];
/** The capability a card's kind of work implies; `--needs` names one outright. */
const WORK_NEEDS: Partial<Record<WorkType, Capability>> = { coding: 'code', ops: 'deploy', research: 'web' };

export function neededCapability(work: string | null | undefined, needs: string | undefined): Capability | null {
  if (needs !== undefined) {
    if (!(CARD_NEEDS as readonly string[]).includes(needs)) throw new OrgError(`--needs ${needs}: one of ${CARD_NEEDS.join(', ')}`);
    return needs as Capability;
  }
  return work ? WORK_NEEDS[work as WorkType] ?? null : null;
}

/** A card goes only to a bot that has the tools for it; the refusal names the bots that do. (The board function checks the same.) */
export async function assertCapable(to: Agent, need: Capability | null): Promise<void> {
  if (!need || to.runtime === 'session' || (to.capabilities ?? []).includes(need)) return;
  const { rows } = await query<{ name: string }>(
    `SELECT name FROM org_agents WHERE $1 = ANY (capabilities) AND retired_at IS NULL AND runtime <> 'human' ORDER BY name`,
    [need],
  );
  throw new OrgError(`${to.name} doesn't have the ${need} capability this card needs; give it to ${rows.map((r) => r.name).join(', ') || 'nobody yet (add it in org.yaml)'}`);
}

/** A graph node's need: build cards by the template's work, a code review needs a reviewer, spec and verify none. */
export function nodeNeed(kind: string, work: string | null | undefined): Capability | null {
  if (kind === 'build' || kind === 'work') return neededCapability(work, undefined);
  if (kind === 'review' && work === 'coding') return 'review';
  return null;
}

/**
 * Runs `hermes kanban …` and returns stdout: the projection of the engine's cards into the Hermes board, for as
 * long as Hermes runs the bots (BOARD_HERMES_PROJECTION=on). Null when the engine's record is the only board.
 */
export type KanbanRunner = (args: string[]) => Promise<string>;

/** The projection runner this machine is configured for, or null. ORG_KANBAN_CMD names the binary (tests). */
export function hermesProjection(env: NodeJS.ProcessEnv = process.env): KanbanRunner | null {
  if (!config.boardHermesProjection && !env.ORG_KANBAN_CMD) return null;
  const cmd = env.ORG_KANBAN_CMD ?? 'hermes';
  return (args) =>
    new Promise((ok, fail) => {
      execFile(cmd, args, { env, timeout: 30_000, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
        if (err) fail(new OrgError(`kanban: ${(stderr || err.message).trim().slice(0, 300)}`));
        else ok(stdout);
      });
    });
}

export const DEFAULT_BOARD = 'exo';
export const MAX_ROUNDS = 2;
const CARD_ID = /^t_[0-9a-f]{6,32}$/;
const BOARD_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * Vault code is worked by a Claude Code session on the owner's machine, never by a bot: the vault holds private notes
 * and isn't a bot repo (decided 2026-10-21). The vault assignee (ORG_VAULT_ASSIGNEE, default `vault-session`) is a
 * roster row with runtime `session` that no lane claims; its cards wait in ready for a session there. Boards that
 * predate the setting still use `m4`, which stays recognised.
 */
export const VAULT_ASSIGNEE = config.orgVaultAssignee;
const LEGACY_VAULT_ASSIGNEE = 'm4';
export const VAULT_REPO = 'vault';
const VAULT_ROLE = "Claude Code session on the owner's machine (vault work)";

/** True for the configured vault assignee and the legacy slug. */
export function isVaultAssignee(name: string): boolean {
  return name === VAULT_ASSIGNEE || name === LEGACY_VAULT_ASSIGNEE;
}

/**
 * The roster agent; the vault session's row is made on first use (an older import may predate it).
 * The upsert runs through board_ensure_vault_agent (a SECURITY DEFINER function), not a direct INSERT:
 * under the owner's own connection a direct INSERT would work, but this also runs under the sb_org
 * row-level-security role (ORG_AGENT set, as any bot's own wakes connect, or `cli-org`/`cli-board` run
 * with ORG_AGENT for the RLS path), which has only SELECT on org_agents.
 */
async function cardTarget(name: string): Promise<Agent> {
  if (isVaultAssignee(name)) {
    const reportsTo = (await query<{ name: string }>(`SELECT name FROM org_agents WHERE runtime = 'human' ORDER BY (name = $1) DESC LIMIT 1`, [config.orgOwner])).rows[0]?.name ?? null;
    await query(`SELECT board_ensure_vault_agent($1, $2, $3)`, [name, VAULT_ROLE, reportsTo]);
  }
  return getAgent(name);
}

/** The repos a bot can branch and push in: the registry plus the ones the bots created. Null when this machine has no registry. */
export function botRepos(file = process.env.BOT_REPOS_FILE ?? '/etc/secondbrain/bot-repos.toml'): string[] | null {
  let toml: string;
  try {
    toml = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const names = [...toml.matchAll(/^\[repos\.([A-Za-z0-9._-]+)\]/gm)].map((m) => m[1]!);
  const workDir = /^work_dir\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  if (workDir) {
    try {
      names.push(...Object.keys(JSON.parse(readFileSync(join(workDir, 'created-repos.json'), 'utf8')) as Record<string, unknown>));
    } catch {
      /* no repos created yet */
    }
  }
  return [...new Set(names)];
}

/**
 * Where a card's code lives decides who may get it (2026-10-21: a vault script given to rune dead-ended, t_47e2a857).
 * The vault session takes vault work only; vault work goes only to the vault session; a bot's coding card for a bot
 * names a repo the bots reach (the owner may leave it out: the builder asks).
 */
export function checkRepo(caller: Agent, to: Agent, need: Capability | null, repo: string | undefined, repos: string[] | null = botRepos()): string | undefined {
  if (isVaultAssignee(to.name)) {
    if (repo !== undefined && repo !== VAULT_REPO) throw new OrgError(`${to.name} takes vault work only; give a ${repo} card to a bot with code`);
    return VAULT_REPO;
  }
  if (repo === VAULT_REPO) {
    throw new OrgError(`vault code is worked by a Claude Code session on the owner's machine, not by a bot: cli-org task create ${VAULT_ASSIGNEE} "<title>" --project <p> --repo vault`);
  }
  if (need !== 'code' || (!repo && caller.runtime === 'human')) return repo;
  if (!repo) {
    throw new OrgError(`a coding card names its repo: --repo <name>${repos ? ` (one of ${repos.join(', ')})` : ''}; vault code goes to ${VAULT_ASSIGNEE} with --repo vault`);
  }
  if (repos && !repos.includes(repo)) {
    throw new OrgError(`no bot can push to ${repo}: the bots reach ${repos.join(', ')}; vault code goes to ${VAULT_ASSIGNEE} with --repo vault, a new repo starts with cli-git repo create`);
  }
  return repo;
}

/**
 * Who may give whom a card: a human anyone on the roster; the bot with `dispatch` (the chief of staff) any bot; a lead
 * its own team; a member only itself. The vault session takes cards from a human, a lead or `dispatch`. The board
 * function board_may_assign() enforces the same rule; this one gives the CLI its message before anything is written.
 */
export async function assertMayAssign(caller: Agent, to: Agent): Promise<void> {
  if (to.runtime === 'human') throw new OrgError(`${to.name} is not a bot; cards go to bots on the roster`);
  if (caller.runtime === 'human' || caller.name === to.name) return;
  if ((caller.capabilities ?? []).includes('dispatch')) return;
  if (isVaultAssignee(to.name) || to.runtime === 'session') {
    if (await isLead(caller.name)) return;
    throw new OrgError(`${caller.name} can't give the vault session a card: leads do; ask your lead`);
  }
  if (caller.team_slug && caller.team_slug === to.team_slug && (await isLead(caller.name))) return;
  throw new OrgError(`${caller.name} can't give ${to.name} a card: a lead assigns inside its team, a member only to itself; ask your lead or hand off on the board`);
}

async function assertProject(project: string | undefined, feature?: string): Promise<{ title: string; team_slug: string | null }> {
  if (!project) {
    if (feature) throw new OrgError('a feature needs its project: --project <slug>');
    return { title: '', team_slug: null };
  }
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
  contract?: Contract;
  project?: string;
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
  repo?: string;
  needs?: string | null;
  shipNow?: boolean;
}

/** The lines at the top of a card's body that tell its bot how to finish: the one place the closing commands are written. */
function cardHeader(caller: Agent, to: Agent, c: CardSpec): string {
  const ref = c.project ? `${c.project}${c.feature ? `/${c.feature}` : ''}` : null;
  const lines = [...(ref ? [`Project: ${ref}`] : [])];
  if (isVaultAssignee(to.name) || to.runtime === 'session') {
    lines.push(
      `Assigned by ${caller.name}. Repo: vault. Worked by a Claude Code session on the owner's machine; no bot wakes for it.`,
      `Take it: cli-board move <this card> running. When done: cli-board finish <this card> --done "<the commits>", plus a dev log as the vault rules ask.`,
    );
  } else {
    const channel = to.team_slug ?? 'all-hands';
    lines.push(
      `Assigned by ${caller.name}.${c.repo ? ` Repo: ${c.repo}.` : ''}${c.graph ? ` Graph ${c.graph}, node ${c.node}${c.kind && c.kind !== 'work' ? ` (${c.kind})` : ''}.` : ''}${c.rounds ? ` Round ${c.rounds}.` : ''}`,
      `When done: cli-org post ${channel} "<what changed, with a path or command>" --kind status --task <this card>${ref ? ` --project ${c.project}${c.feature ? ` --feature ${c.feature}` : ''}` : ''}, then cli-board finish <this card> --done "<result>". Blocked: cli-board finish <this card> --blocked <kind> "<why>" and tell your lead.`,
    );
  }
  if (c.extra) lines.push(c.extra);
  return lines.join('\n');
}

function boardErr(err: unknown): never {
  if (err instanceof BoardError) throw new OrgError(err.message);
  throw err;
}

/**
 * The one path that makes a card for a bot: the board function writes the record (status, dependencies, the
 * feature's owner, the wakeup when it is ready); when a Hermes projection runs, the same card is created there
 * first and its id is the record's, so both boards agree.
 */
async function createBoardCard(caller: Agent, to: Agent | null, c: CardSpec, run: KanbanRunner | null | undefined): Promise<Card> {
  const title = c.title.trim().replace(/\s+/g, ' ');
  if (!title || title.length > 200) throw new OrgError('a card title is 1 to 200 characters');
  if ((c.body ?? '').length > 6000) throw new OrgError('a card body is at most 6000 characters');
  const board = c.board ?? DEFAULT_BOARD;
  if (!BOARD_RE.test(board)) throw new OrgError(`bad board name "${board}"`);
  const body = to ? (c.body?.trim() ? `${cardHeader(caller, to, c)}\n\n${c.body.trim()}` : cardHeader(caller, to, c)) : c.body?.trim() || undefined;
  let id: string | undefined;
  if (run && to) {
    const args = ['kanban', '--board', board, 'create', `--body=${body ?? ''}`, '--assignee', to.name, '--created-by', caller.name, '--json'];
    if (c.priority !== undefined) args.push('--priority', String(c.priority));
    for (const parent of c.parents ?? []) args.push('--parent', parent);
    args.push('--', title);
    const out = await run(args);
    try {
      const doc = JSON.parse(out) as { id?: string; task?: { id?: string } };
      id = doc.id ?? doc.task?.id;
    } catch {
      /* fall through */
    }
    if (!id || !CARD_ID.test(id)) throw new OrgError(`kanban create returned no card id: ${out.trim().slice(0, 200)}`);
  }
  return createCard(caller.name, {
    id, board, title, body, contract: c.contract, assignee: to?.name ?? null, project: c.project, feature: c.feature, kind: c.kind, work: checkWorkType(c.work) ?? undefined,
    needs: c.needs ?? undefined, repo: c.repo, priority: c.priority, deps: c.parents, graph: c.graph, node: c.node, rounds: c.rounds, shipNow: c.shipNow,
  }).catch(boardErr);
}

export interface CreateTaskOpts {
  /** A roster name, or null for an unassigned card on the board (the owner's backlog). */
  assignee: string | null;
  title: string;
  body?: string;
  contract?: Contract;
  project?: string;
  feature?: string;
  board?: string;
  priority?: number;
  /** research | coding | design | media | writing | sales | education | ops; else the bot's default on /usage. */
  type?: string;
  /** The capability the card needs, when its type doesn't say (e.g. m1 for a video job). */
  needs?: string;
  /** The owner says ship without asking: merge and deploy skip the approval. Humans only. */
  shipNow?: boolean;
  /** Where the code lives: a bot repo (required for coding cards) or `vault` (only for the vault session). */
  repo?: string;
  kind?: string;
  /** Cards this one waits for. */
  deps?: string[];
  run?: string;
}

/**
 * One card, one bot, one project. Writes the card through the board (the record, the feature's owner, the
 * wakeup) and, when someone else gave the card, posts a note in the bot's team channel so the board carries the
 * conversation. The card is `ready` at once unless it waits for other cards; its lane claims it on the next tick.
 */
export async function createTask(caller: Agent, opts: CreateTaskOpts, run?: KanbanRunner | null): Promise<{ task_id: string; card: Card; link: TaskLink; message: Message | null }> {
  const to = opts.assignee ? await cardTarget(opts.assignee) : null;
  if (to) await assertMayAssign(caller, to);
  if (opts.shipNow && caller.runtime !== 'human') throw new OrgError('only the owner can mark a card ship-now');
  const need = to && isVaultAssignee(to.name) ? null : neededCapability(opts.type, opts.needs);
  if (to) await assertCapable(to, need);
  const repo = to ? checkRepo(caller, to, need, opts.repo) : opts.repo;
  await assertProject(opts.project, opts.feature);
  const extra = opts.shipNow ? 'Ship-now: the owner said to ship this without asking; `cli-org ship request` is approved on the spot.' : undefined;
  const card = await createBoardCard(caller, to, { ...opts, parents: opts.deps, work: opts.type, extra, repo, needs: need }, run);
  const link = linkOfCard(card);
  const message = to ? await mentionCard(caller, to, link, opts.run) : null;
  return { task_id: card.id, card, link, message };
}

/** The note in the bot's team channel that makes the board carry the card. Nothing when a bot gives itself a card. */
async function mentionCard(caller: Agent, to: Agent, link: TaskLink, run?: string): Promise<Message | null> {
  if (caller.name === to.name || !to.team_slug) return null;
  const ref = link.project_slug ? ` (${link.project_slug}${link.feature_slug ? `/${link.feature_slug}` : ''})` : '';
  // A note, not a mention: the card wakes the bot when it is ready, and an @-mention made a second wake (for a `todo`
  // card, a wake with nothing to do yet). A handoff would also wake the lead.
  // The dispatch bot isn't in the other teams' channels: its note goes to #leads, where the bot's lead reads it.
  const channel = caller.runtime !== 'human' && caller.team_slug !== to.team_slug && (caller.capabilities ?? []).includes('dispatch') ? 'leads' : to.team_slug;
  return post(caller, channel, `card ${link.task_id} for ${to.name}: ${link.title}${ref}`, { task: link.task_id, project: link.project_slug ?? undefined, feature: link.feature_slug ?? undefined, run });
}

export interface AssignTaskOpts {
  taskId: string;
  assignee: string;
  project?: string;
  feature?: string;
  board?: string;
  type?: string;
  needs?: string;
  shipNow?: boolean;
  repo?: string;
  run?: string;
}

/**
 * An existing card (one the owner made from the page, an unassigned one, or someone else's) becomes a bot's: the
 * board function moves the assignee and the feature's owner, the closing commands go in a comment, and the bot is
 * noted in its team channel. The card keeps its status, so a `todo` card still waits for its parents and a `ready`
 * one wakes the bot now. With a Hermes projection the same assign and comment are mirrored there.
 */
export async function assignTask(caller: Agent, opts: AssignTaskOpts, run?: KanbanRunner | null): Promise<{ task_id: string; card: Card; link: TaskLink; message: Message | null }> {
  if (!CARD_ID.test(opts.taskId)) throw new OrgError(`bad card id "${opts.taskId}"`);
  const to = await cardTarget(opts.assignee);
  await assertMayAssign(caller, to);
  if (opts.shipNow && caller.runtime !== 'human') throw new OrgError('only the owner can mark a card ship-now');
  const need = isVaultAssignee(to.name) ? null : neededCapability(opts.type, opts.needs);
  await assertCapable(to, need);
  const repo = checkRepo(caller, to, need, opts.repo);
  await assertProject(opts.project, opts.feature);
  const { rows } = await query<Card>(`SELECT * FROM cards WHERE id = $1`, [opts.taskId]);
  const before = rows[0];
  if (!before) throw new OrgError(`no card ${opts.taskId} on the board (cli-board show ${opts.taskId})`);
  if (before.status === 'done' || before.status === 'archived') throw new OrgError(`card ${opts.taskId} is ${before.status}; give ${to.name} a new card instead`);
  if (before.status === 'running') throw new OrgError(`card ${opts.taskId} is running; wait for the worker or reclaim it first`);
  const header = cardHeader(caller, to, { title: before.title, project: opts.project ?? before.project_slug ?? undefined, feature: opts.feature ?? (opts.project ? undefined : before.feature_slug ?? undefined), board: before.board_slug, repo });
  const card = await assignCard(caller.name, opts.taskId, to.name, { project: opts.project, feature: opts.feature, work: checkWorkType(opts.type) ?? undefined, needs: need ?? undefined }).catch(boardErr);
  await commentOnCard(caller.name, opts.taskId, header);
  if (opts.shipNow) await flagCard(caller.name, opts.taskId, { shipNow: true }).catch(boardErr);
  if (repo && repo !== card.repo) await query(`UPDATE cards SET repo = $2 WHERE id = $1`, [opts.taskId, repo]);
  if (run) {
    await run(['kanban', '--board', before.board_slug, 'assign', opts.taskId, to.name]);
    await run(['kanban', '--board', before.board_slug, 'comment', '--author', caller.name, '--', opts.taskId, header]);
  }
  const link = linkOfCard({ ...card, repo: repo ?? card.repo, ship_now: card.ship_now || opts.shipNow === true });
  const message = await mentionCard(caller, to, link, opts.run);
  return { task_id: opts.taskId, card: { ...card, ship_now: link.ship_now }, link, message };
}

async function commentOnCard(by: string, id: string, body: string): Promise<void> {
  await commentCard(by, id, body).catch(boardErr);
}

export interface TaskFilter {
  project?: string;
  feature?: string;
  agent?: string;
  limit?: number;
}

/** Cards for bots with their project and feature, newest first (the task_links view over cards). */
export async function listTasks(f: TaskFilter = {}): Promise<(TaskLink & { status: string })[]> {
  const { rows } = await query<TaskLink & { status: string }>(
    `SELECT l.*, c.status FROM task_links l JOIN cards c ON c.id = l.task_id
      WHERE ($1::text IS NULL OR l.project_slug = $1) AND ($2::text IS NULL OR l.feature_slug = $2) AND ($3::text IS NULL OR l.assignee = $3)
      ORDER BY l.created_at DESC, l.task_id LIMIT $4`,
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
export async function applyGraph(caller: Agent, template: GraphTemplate, opts: ApplyOpts, run?: KanbanRunner | null): Promise<{ cards: PlannedCard[]; message: Message | null }> {
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
    await assertCapable(to, nodeNeed(n.kind, n.work ?? template.work));
    for (const a of n.after) if (!planned.some((p) => p.node === a)) throw new OrgError(`graph ${template.name}: node ${n.id} is after unknown node ${a}`);
    planned.push({ node: n.id, kind: n.kind, assignee: name, title: fill(n.title, vars), after: n.after, task_id: null });
  }
  if (opts.dryRun) return { cards: planned, message: null };
  const ids = new Map<string, string>();
  for (const [i, n] of template.nodes.entries()) {
    const card = planned[i]!;
    const { id: task_id } = await createBoardCard(caller, agents.get(card.assignee)!, {
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
      needs: nodeNeed(n.kind, n.work ?? template.work),
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
    // Names, not @-mentions: each card wakes its bot when it becomes ready, so a mention would only add a wake.
    message = await post(caller, channel, `${roots.join(' ')}${roots.length ? ': ' : ''}graph ${template.name} for ${opts.project}${opts.feature ? `/${opts.feature}` : ''}: ${chain}`, {
      project: opts.project, feature: opts.feature, run: opts.run, task: planned[0]?.task_id ?? undefined,
    });
  }
  return { cards: planned, message };
}

// ---- the review loop ----------------------------------------------------------

async function cardOf(taskId: string): Promise<Card> {
  if (!CARD_ID.test(taskId)) throw new OrgError(`bad card id "${taskId}"`);
  const { rows } = await query<Card>(`SELECT * FROM cards WHERE id = $1`, [taskId]);
  if (!rows[0]) throw new OrgError(`no card ${taskId} on the board`);
  if (!rows[0].assignee) throw new OrgError(`card ${taskId} is nobody's (no assignee)`);
  return rows[0];
}

/**
 * Changes requested on a review card: a new round of the reviewed card for its builder, which the review card
 * then waits for (blocked on a dependency; the board promotes it again when the round is done). After MAX_ROUNDS
 * the lead is told instead and the review card stays blocked.
 */
export async function redoTask(caller: Agent, reviewId: string, changes: string, run?: KanbanRunner | null, runId?: string): Promise<{ escalated: boolean; task_id: string | null; rounds: number; message: Message | null }> {
  const text = Body.parse(changes);
  const review = await cardOf(reviewId);
  const reviewer = await getAgent(review.assignee!);
  if (caller.runtime !== 'human' && caller.name !== review.assignee) await assertMayAssign(caller, reviewer);
  const { rows: candidates } = await query<Card>(
    `SELECT c.* FROM card_deps d JOIN cards c ON c.id = d.depends_on WHERE d.card_id = $1 AND c.assignee IS NOT NULL ORDER BY c.rounds DESC, c.created_at DESC`,
    [reviewId],
  );
  const reviewed = candidates.find((c) => c.kind !== 'review') ?? candidates[0];
  if (!reviewed) throw new OrgError(`card ${reviewId} reviews nothing: it waits for no card`);
  const builder = await getAgent(reviewed.assignee!);
  const rounds = reviewed.rounds + 1;
  const team = builder.team_slug ?? reviewer.team_slug;
  const lead = team ? ((await query<{ lead: string | null }>(`SELECT lead FROM teams WHERE slug = $1`, [team])).rows[0]?.lead ?? null) : null;
  if (rounds > MAX_ROUNDS) {
    const note = `Round ${rounds} refused: ${MAX_ROUNDS} rounds are the limit. Escalated to ${lead ?? 'the lead'}. Changes asked: ${text}`;
    await commentOnCard(caller.name, reviewId, note);
    if (run) await run(['kanban', '--board', review.board_slug, 'comment', '--author', caller.name, '--', reviewId, note]);
    let message: Message | null = null;
    if (lead && lead !== caller.name) message = await dm(caller, lead, `Card ${reviewId} (${reviewed.title}) failed review ${rounds - 1} times; it needs you. Last changes asked: ${text}`, { task: reviewId, run: runId });
    else if (team) message = await post(caller, team, `Card ${reviewId} (${reviewed.title}) failed review ${rounds - 1} times; escalated. Last changes asked: ${text}`, { task: reviewId, project: review.project_slug ?? undefined, feature: review.feature_slug ?? undefined, run: runId });
    return { escalated: true, task_id: null, rounds, message };
  }
  const baseTitle = reviewed.title.replace(/ \(round \d+\)$/, '');
  const { id: task_id } = await createBoardCard(caller, builder, {
    title: `${baseTitle} (round ${rounds})`,
    body: `Changes requested by ${caller.name} on ${reviewId}:\n${text}`,
    project: reviewed.project_slug ?? review.project_slug ?? undefined,
    feature: reviewed.feature_slug ?? review.feature_slug ?? undefined,
    board: reviewed.board_slug,
    graph: reviewed.graph ?? undefined,
    node: reviewed.node ?? undefined,
    kind: reviewed.kind,
    rounds,
    work: reviewed.work_type ?? undefined,
    needs: reviewed.needs,
    repo: reviewed.repo ?? undefined,
    extra: `Review card: ${reviewId} (it reopens when this round is done).`,
  }, run);
  await linkCards(caller.name, reviewId, task_id).catch(boardErr);
  // The builder's latest episode on the reviewed card was corrected: the per-agent metric the memory ledger reads.
  await query(
    `UPDATE org_agent_episodes SET corrected = true WHERE id = (SELECT id FROM org_agent_episodes WHERE agent_name = $1 AND task_id = $2 ORDER BY id DESC LIMIT 1)`,
    [builder.name, reviewed.id],
  ).catch(() => undefined);
  await moveCard(caller.name, reviewId, 'blocked', `changes requested (round ${rounds}); waits for ${task_id}`).catch(boardErr);
  await query(`UPDATE cards SET block_kind = 'dependency', rounds = $2 WHERE id = $1`, [reviewId, rounds]);
  if (run) {
    await run(['kanban', '--board', review.board_slug, 'link', task_id, reviewId]);
    await run(['kanban', '--board', review.board_slug, 'block', '--kind', 'dependency', reviewId, `changes requested (round ${rounds}); waits for ${task_id}`]);
  }
  let message: Message | null = null;
  if (team && (caller.runtime === 'human' || caller.team_slug === team)) {
    message = await post(caller, team, `${builder.name}: round ${rounds} of ${baseTitle}: card ${task_id}. ${text.slice(0, 300)}`, { task: task_id, project: reviewed.project_slug ?? undefined, feature: reviewed.feature_slug ?? undefined, run: runId });
  }
  return { escalated: false, task_id, rounds, message };
}
