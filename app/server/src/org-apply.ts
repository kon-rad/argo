import { query, withTransaction, type TxClient } from './db.js';
import { checkOrg, OrgError, orgChannels, writeOrg, type OrgDocT } from './org.js';

/**
 * The reconcile loop for the org file (docs/org-routing.md): `plan` diffs the compiled file against the tables and
 * changes nothing; `apply` writes the additive changes and edits, and retires an agent the file dropped only with
 * --prune. A retirement drains the bot in the same transaction: pending wakes are cancelled, its open cards go to its
 * lead with a comment, its capabilities are cleared. A bot with a run in flight keeps its row until the run ends; the
 * next `apply --prune` finishes the job. A team the file dropped is archived, never deleted, and only once it has no
 * members and no open cards. Every apply leaves a config_applies row with the plan and what it did.
 */

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface RetirePlan {
  name: string;
  /** Who gets its open cards: its team's lead in the file, or null (unassigned, for the owner to triage). */
  to: string | null;
  open_cards: string[];
  pending_wakeups: number;
  /** A claimed wakeup or a running card: the run finishes first and the retirement waits for the next apply. */
  in_flight: string[];
}

export interface TeamRemoval {
  slug: string;
  /** Agents still on the team after this apply; any one refuses the removal. */
  members: string[];
  /** Open cards on the team's boards; any one refuses the removal. */
  open_cards: string[];
}

export interface OrgPlan {
  version: string;
  prune: boolean;
  wake_rules: boolean;
  agents: { add: string[]; unretire: string[]; change: { name: string; changes: FieldChange[] }[]; retire: RetirePlan[] };
  teams: { add: string[]; change: { slug: string; changes: FieldChange[] }[]; remove: TeamRemoval[] };
  channels: { add: string[]; remove: string[]; members: { slug: string; add: string[]; remove: string[] }[] };
}

export interface ApplyResult {
  id: number;
  plan: OrgPlan;
  retired: string[];
  deferred: string[];
  kept: string[];
  cancelled_wakeups: number;
  cards: { id: string; to: string | null }[];
  untouched_cards: string[];
}

interface DbAgent {
  name: string;
  team_slug: string | null;
  runtime: string;
  role: string;
  model: string | null;
  expertise: string | null;
  work: string | null;
  capabilities: string[];
  routines: unknown;
  reports_to: string | null;
  retired_at: Date | null;
}

const OPEN = `status NOT IN ('done', 'archived')`;

/** JSON with sorted keys: jsonb reorders keys, so a plain stringify would report a change that isn't one. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canon(x)}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const sorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

function agentChanges(row: DbAgent, a: OrgDocT['agents'][string]): FieldChange[] {
  const want: Record<string, unknown> = {
    team: a.team ?? null, runtime: a.runtime, role: a.role, model: a.model ?? null, capabilities: sorted(a.capabilities ?? []),
    reports_to: a.reports_to ?? null, expertise: a.expertise ?? null, work: a.work ?? null, routines: a.routines ?? [],
  };
  const have: Record<string, unknown> = {
    team: row.team_slug, runtime: row.runtime, role: row.role, model: row.model, capabilities: sorted(row.capabilities ?? []),
    reports_to: row.reports_to, expertise: row.expertise, work: row.work, routines: row.routines ?? [],
  };
  return Object.keys(want).filter((k) => canon(want[k]) !== canon(have[k])).map((k) => ({ field: k, from: have[k], to: want[k] }));
}

/** The diff between the org file and the tables. `q` is a transaction when apply calls it, so the plan it acts on is the one it records. */
export async function planOrg(doc: OrgDocT, opts: { prune?: boolean } = {}, tx: TxClient = { query }): Promise<OrgPlan> {
  const prune = opts.prune === true;
  const agents = (await tx.query<DbAgent>(
    `SELECT name, team_slug, runtime, role, model, expertise, work, capabilities, routines, reports_to, retired_at FROM org_agents`,
  )).rows;
  const byName = new Map(agents.map((r) => [r.name, r]));
  const plan: OrgPlan = {
    version: doc.version, prune, wake_rules: false,
    agents: { add: [], unretire: [], change: [], retire: [] },
    teams: { add: [], change: [], remove: [] },
    channels: { add: [], remove: [], members: [] },
  };

  const rules = (await tx.query<{ rules: unknown }>(`SELECT rules FROM org_wake_rules WHERE id`)).rows[0]?.rules ?? {};
  plan.wake_rules = canon(rules) !== canon(doc.wake_rules ?? {});

  for (const [name, a] of Object.entries(doc.agents)) {
    const row = byName.get(name);
    if (!row) { plan.agents.add.push(name); continue; }
    if (row.retired_at) plan.agents.unretire.push(name);
    const changes = agentChanges(row, a);
    if (changes.length) plan.agents.change.push({ name, changes });
  }

  // Agents the file dropped. Session rows (the vault session, service lanes) are never the file's to retire.
  const missing = agents.filter((r) => !r.retired_at && r.runtime !== 'session' && !doc.agents[r.name]).sort((x, y) => x.name.localeCompare(y.name));
  for (const r of missing) {
    const lead = r.team_slug ? doc.teams[r.team_slug]?.lead ?? null : null;
    const cards = (await tx.query<{ id: string; status: string }>(`SELECT id, status FROM cards WHERE assignee = $1 AND ${OPEN} ORDER BY id`, [r.name])).rows;
    const wakes = (await tx.query<{ id: string; claimed_at: Date | null }>(`SELECT id, claimed_at FROM org_wakeups WHERE agent_name = $1 AND done_at IS NULL`, [r.name])).rows;
    plan.agents.retire.push({
      name: r.name,
      to: lead && lead !== r.name ? lead : null,
      open_cards: cards.filter((c) => c.status !== 'running').map((c) => c.id),
      pending_wakeups: wakes.filter((w) => !w.claimed_at).length,
      in_flight: [...wakes.filter((w) => w.claimed_at).map((w) => `wakeup ${w.id}`), ...cards.filter((c) => c.status === 'running').map((c) => `card ${c.id}`)],
    });
  }
  const leaving = new Set(plan.agents.retire.filter((r) => prune && !r.in_flight.length).map((r) => r.name));

  const teams = (await tx.query<{ slug: string; name: string; lead: string | null; archived_at: Date | null; managed: boolean }>(
    `SELECT t.slug, t.name, t.lead, t.archived_at,
            EXISTS (SELECT 1 FROM org_channels c WHERE c.team_slug = t.slug AND c.kind = 'team')
            OR EXISTS (SELECT 1 FROM org_agents a WHERE a.team_slug = t.slug) AS managed
       FROM teams t`,
  )).rows;
  const teamBySlug = new Map(teams.map((t) => [t.slug, t]));
  for (const [slug, t] of Object.entries(doc.teams)) {
    const row = teamBySlug.get(slug);
    if (!row || row.archived_at) { plan.teams.add.push(slug); continue; }
    const changes: FieldChange[] = [];
    if (row.name !== t.name) changes.push({ field: 'name', from: row.name, to: t.name });
    if (row.lead !== t.lead) changes.push({ field: 'lead', from: row.lead, to: t.lead });
    if (changes.length) plan.teams.change.push({ slug, changes });
  }
  // Only teams the org wrote: the tracker shares the table and may hold teams the org file never named.
  for (const t of teams.filter((x) => x.managed && !x.archived_at && !doc.teams[x.slug]).sort((x, y) => x.slug.localeCompare(y.slug))) {
    const members = agents.filter((r) => r.team_slug === t.slug && !r.retired_at && !doc.agents[r.name] && !leaving.has(r.name)).map((r) => r.name).sort();
    const cards = (await tx.query<{ id: string }>(
      `SELECT c.id FROM cards c JOIN boards b ON b.slug = c.board_slug WHERE b.team_slug = $1 AND c.${OPEN} ORDER BY c.id`, [t.slug],
    )).rows.map((c) => c.id);
    plan.teams.remove.push({ slug: t.slug, members, open_cards: cards });
  }

  const specs = orgChannels(doc);
  const channels = (await tx.query<{ slug: string; archived_at: Date | null }>(`SELECT slug, archived_at FROM org_channels WHERE kind <> 'dm'`)).rows;
  const live = new Map(channels.map((c) => [c.slug, c]));
  const seats = (await tx.query<{ channel_slug: string; agent_name: string }>(
    `SELECT m.channel_slug, m.agent_name FROM org_channel_members m JOIN org_channels c ON c.slug = m.channel_slug WHERE c.kind <> 'dm'`,
  )).rows;
  const keep = new Set(plan.agents.retire.map((r) => r.name).filter((n) => !leaving.has(n)));
  for (const c of specs) {
    const row = live.get(c.slug);
    if (!row || row.archived_at) plan.channels.add.push(c.slug);
    const have = new Set(seats.filter((s) => s.channel_slug === c.slug).map((s) => s.agent_name));
    const add = c.members.filter((m) => !have.has(m)).sort();
    const remove = [...have].filter((m) => !c.members.includes(m) && !keep.has(m)).sort();
    if (add.length || remove.length) plan.channels.members.push({ slug: c.slug, add, remove });
  }
  const wanted = new Set(specs.map((c) => c.slug));
  plan.channels.remove = channels.filter((c) => !c.archived_at && !wanted.has(c.slug)).map((c) => c.slug).sort();
  return plan;
}

export function planIsEmpty(p: OrgPlan): boolean {
  return !p.wake_rules && !p.agents.add.length && !p.agents.unretire.length && !p.agents.change.length && !p.agents.retire.length
    && !p.teams.add.length && !p.teams.change.length && !p.teams.remove.length
    && !p.channels.add.length && !p.channels.remove.length && !p.channels.members.length;
}

const show = (v: unknown): string => (Array.isArray(v) ? `[${v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ')}]` : v === null || v === undefined ? '-' : typeof v === 'string' ? v : JSON.stringify(v));

/** The plan as lines a person reviews: + add, ~ change, - remove. */
export function formatPlan(p: OrgPlan): string {
  if (planIsEmpty(p)) return `org ${p.version}: no changes`;
  const out = [`org ${p.version}:`];
  for (const n of p.agents.add) out.push(`+ agent ${n}`);
  for (const n of p.agents.unretire) out.push(`+ agent ${n} (un-retire)`);
  for (const c of p.agents.change) out.push(`~ agent ${c.name}: ${c.changes.map((f) => `${f.field} ${show(f.from)} -> ${show(f.to)}`).join('; ')}`);
  for (const r of p.agents.retire) {
    const what = [
      r.open_cards.length ? `${r.open_cards.length} open card${r.open_cards.length === 1 ? '' : 's'} to ${r.to ?? 'nobody (owner triage)'}` : '',
      r.pending_wakeups ? `${r.pending_wakeups} pending wakeup${r.pending_wakeups === 1 ? '' : 's'} cancelled` : '',
      r.in_flight.length ? `in flight: ${r.in_flight.join(', ')} (retires on the next apply --prune after the run ends)` : '',
    ].filter(Boolean).join('; ');
    out.push(p.prune ? `- agent ${r.name}: retire${what ? ` (${what})` : ''}` : `- would retire ${r.name} (pass --prune)${what ? `: ${what}` : ''}`);
  }
  for (const s of p.teams.add) out.push(`+ team ${s}`);
  for (const c of p.teams.change) out.push(`~ team ${c.slug}: ${c.changes.map((f) => `${f.field} ${show(f.from)} -> ${show(f.to)}`).join('; ')}`);
  for (const t of p.teams.remove) {
    const why = [t.members.length ? `members ${t.members.join(', ')}` : '', t.open_cards.length ? `open cards ${t.open_cards.join(', ')}` : ''].filter(Boolean).join('; ');
    out.push(why ? `- team ${t.slug}: REFUSED while it has ${why}` : `- team ${t.slug}: archive`);
  }
  for (const s of p.channels.add) out.push(`+ channel ${s}`);
  for (const s of p.channels.remove) out.push(`- channel ${s}: archive`);
  for (const m of p.channels.members) out.push(`~ channel ${m.slug}: ${[...m.add.map((x) => `+${x}`), ...m.remove.map((x) => `-${x}`)].join(' ')}`);
  if (p.wake_rules) out.push('~ wake_rules');
  return out.join('\n');
}

export async function planOrgFile(input: unknown, opts: { prune?: boolean } = {}): Promise<OrgPlan> {
  return planOrg(checkOrg(input), opts);
}

export interface ApplyOpts {
  prune?: boolean;
  sha?: string;
  by?: string;
}

/**
 * Applies the org file in one transaction and records it. Refused, with nothing written, when the file drops a team
 * that still has members or open cards. The owner (the file's ceo) is the board caller for the card moves.
 */
export async function applyOrg(input: unknown, opts: ApplyOpts = {}): Promise<ApplyResult> {
  const doc = checkOrg(input);
  const prune = opts.prune === true;
  return withTransaction(async (tx) => {
    const plan = await planOrg(doc, { prune }, tx);
    const blocked = plan.teams.remove.filter((t) => t.members.length || t.open_cards.length);
    if (blocked.length) {
      throw new OrgError(`refused, nothing applied: ${blocked.map((t) => `team ${t.slug} still has ${[
        t.members.length ? `members ${t.members.join(', ')}` : '', t.open_cards.length ? `open cards ${t.open_cards.join(', ')}` : '',
      ].filter(Boolean).join(' and ')}`).join('; ')}. Move or retire them first.`);
    }

    const retiring = prune ? plan.agents.retire.filter((r) => !r.in_flight.length) : [];
    const deferred = prune ? plan.agents.retire.filter((r) => r.in_flight.length) : [];
    const kept = prune ? [] : plan.agents.retire;
    const teamOf = new Map((await tx.query<{ name: string; team_slug: string | null }>(
      `SELECT name, team_slug FROM org_agents WHERE name = ANY ($1)`, [[...deferred, ...kept].map((r) => r.name)],
    )).rows.map((r) => [r.name, r.team_slug]));
    await writeOrg(tx, doc, { retireMissing: false, keep: teamOf });

    const result: ApplyResult = {
      id: 0, plan, retired: [], deferred: deferred.map((r) => r.name), kept: kept.map((r) => r.name), cancelled_wakeups: 0, cards: [], untouched_cards: [],
    };
    // A deferred bot still gets drained of what can move now: its pending wakes and its cards that aren't running.
    for (const r of [...retiring, ...deferred]) {
      const { rowCount } = await tx.query(
        `UPDATE org_wakeups SET done_at = now(), result = $2 WHERE agent_name = $1 AND done_at IS NULL AND claimed_at IS NULL`,
        [r.name, `cancelled: ${r.name} retired by cli-org apply`],
      );
      result.cancelled_wakeups += rowCount ?? 0;
      const to = r.to ? (await tx.query<{ name: string; capabilities: string[]; retired_at: Date | null }>(
        `SELECT name, capabilities, retired_at FROM org_agents WHERE name = $1`, [r.to],
      )).rows[0] : undefined;
      const cards = (await tx.query<{ id: string; status: string; needs: string | null }>(
        `SELECT id, status, needs FROM cards WHERE assignee = $1 AND ${OPEN} ORDER BY id FOR UPDATE`, [r.name],
      )).rows;
      for (const c of cards) {
        if (c.status === 'running') { result.untouched_cards.push(c.id); continue; }
        // The lead takes the card when it can do it; otherwise it waits unassigned for the owner (cards never go to a human).
        const lead = to && !to.retired_at && (!c.needs || to.capabilities.includes(c.needs)) ? to.name : null;
        await tx.query(`SELECT board_card_assign($1, $2, $3, NULL, NULL, NULL, NULL, NULL)`, [doc.ceo, c.id, lead]);
        const why = !lead && to ? ` (${to.name} lacks the ${c.needs} capability)` : '';
        await tx.query(`SELECT board_card_comment($1, $2, $3)`, [
          doc.ceo, c.id, `${r.name} was retired by cli-org apply (org ${doc.version}); ${lead ? `card reassigned to ${lead}, its lead` : `card unassigned for the owner to triage${why}`}.`,
        ]);
        result.cards.push({ id: c.id, to: lead });
      }
    }
    for (const r of retiring) {
      await tx.query(`UPDATE org_agents SET capabilities = '{}', retired_at = now(), updated_at = now() WHERE name = $1`, [r.name]);
      result.retired.push(r.name);
    }

    // Archive, never delete: projects, boards, cards and messages keep joining the row. The lead is cleared so a
    // former lead stops counting as one.
    for (const t of plan.teams.remove) {
      await tx.query(`UPDATE teams SET archived_at = now(), lead = NULL, members = '{}', updated_at = now() WHERE slug = $1`, [t.slug]);
    }
    for (const slug of plan.channels.remove) {
      await tx.query(`UPDATE org_channels SET archived_at = now() WHERE slug = $1`, [slug]);
      // Bots lose the seat (no reads, posts or wakes); the owner keeps it to read the history.
      await tx.query(
        `DELETE FROM org_channel_members m USING org_agents a WHERE m.channel_slug = $1 AND a.name = m.agent_name AND a.runtime <> 'human'`, [slug],
      );
    }

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO config_applies (git_sha, plan, applied_by) VALUES ($1, $2::jsonb, $3) RETURNING id`,
      [opts.sha ?? null, JSON.stringify({ ...plan, result: { ...result, plan: undefined, id: undefined } }), opts.by ?? doc.ceo],
    );
    result.id = Number(rows[0]!.id);
    return result;
  });
}

export function formatApply(r: ApplyResult): string {
  const out = [formatPlan(r.plan), `applied as config_applies #${r.id}`];
  if (r.retired.length) out.push(`retired: ${r.retired.join(', ')}`);
  if (r.deferred.length) out.push(`deferred (run in flight): ${r.deferred.join(', ')}; run apply --prune again after it ends`);
  if (r.cancelled_wakeups) out.push(`cancelled ${r.cancelled_wakeups} pending wakeup${r.cancelled_wakeups === 1 ? '' : 's'}`);
  for (const c of r.cards) out.push(`card ${c.id} -> ${c.to ?? 'unassigned'}`);
  if (r.untouched_cards.length) out.push(`running, left with its bot until the run ends: ${r.untouched_cards.join(', ')}`);
  return out.join('\n');
}
