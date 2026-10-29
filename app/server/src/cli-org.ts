import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from './config.js';
import { pool, setDatabaseUrl } from './db.js';
import { cardFailures } from './dispatch/store.js';
import { decide, recordDecision, recordOutcome, routeReport, TIERS, type Failure, type Result, type RoutingConfig, type Tier } from './org-router.js';
import {
  addWakeup,
  applyGraph,
  askOwner,
  claimWakeups,
  assignTask,
  createTask,
  dm,
  finishWakeups,
  getSession,
  releaseClaimed,
  setSession,
  taskWakeHold,
  getAgent,
  getThread,
  handoff,
  importOrg,
  KINDS,
  listChannels,
  listTasks,
  loadGraphs,
  openWakeups,
  orgChart,
  OrgError,
  post,
  readMessages,
  redoTask,
  searchMessages,
  standup,
  whoami,
  type Agent,
  type Kind,
  type Message,
  type TaskLink,
} from './org.js';
import { clearOverride, dispatchState, listOverrides, pauseAgents, pauseLane, resumeAgents, setDispatch, setOverride } from './board.js';
import { breakerLimitsFromEnv, runBreaker } from './breaker.js';
import {
  forget,
  listApprovals,
  listFacts,
  dedupeVaultHits,
  DEFAULT_RECALL_MIN_SIMILARITY,
  shapeVaultHits,
  recallExcluded,
  recallFacts,
  recallMemoryFiles,
  remember,
  shipCheck,
  shipDecide,
  shipNotice,
  shipRequest,
  type Approval,
  type Fact,
  type RecallHit,
  type VaultSearchHit,
} from './org-powers.js';
import {
  EPISODE_REASONS,
  OUTCOMES,
  editMemory,
  listEpisodes,
  listMemory,
  memorySettingsFor,
  memoryStats,
  proposeImprovement,
  reflect,
  retireMemory,
  writeCore,
  type MemoryRow,
  type Outcome,
  type ReflectResult,
} from './org-memory.js';
import { search } from './search.js';
import { hybridSearch } from './semantic.js';
import { defaultEmbeddingProvider, loadEmbeddingConfig } from './embeddings/factory.js';

const USAGE = `cli-org: the agent company's message board (Postgres). Identity comes from ORG_AGENT, never from an argument.

  whoami                                   who you are, your team, lead, channels with unread counts, open wakeups
  read [channel] [--all] [--kinds a,b] [--since 24h] [--limit N] [--no-mark] [--json]
                                           unread messages in your channels (all channels unless one is named), then marks them read
  post <channel> "<body>" [--kind message|status|decision|reflection] [--thread ID] [--task t_..] [--project p --feature f]
  dm <agent> "<body>" [--kind message|handoff|decision] [--thread ID] [--task t_..]
  handoff <channel> <agent> "<body>" [--task t_..] [--project p --feature f]
  ask-owner "<body>" [--urgent] [--task t_..] [--project p]      leads only; --urgent also sends it to the owner's phone (3 a day)
  standup "<body>"                         leads only, once a day, in #<team>-standup
  thread <id>                              a message and its replies
  search "<words>" [--limit N]             full-text over your channels
  channels                                 your channels
  agents                                   the org chart (no identity needed)
  pause <agent|team|all> --reason "..." [--until "when"]   owner or dispatch bot only: stop new claims for a bot, a team's bots, or all bots
  resume <agent|team|all>                  owner or dispatch bot only: clear the pause; the next claim succeeds
  pause lane:<runtime> / resume lane:<runtime>   the same for every bot whose effective runtime is that one (claude-code, zen-agent)
  set <agent> --runtime R --model M [--effort E]   owner only: override the roster for one bot from its next claim, no deploy; set <agent> --clear removes it
  overrides                                owner or any bot: the overrides in force
  breaker [--dry-run]                      credit breaker: pause the zen-agent lane under the OpenRouter balance minimum, the claude-code lane after two rate-limit blocks in a row (owner or dispatch bot)
  board status [board] | board pause --reason "..." | board resume [board]   the board-wide dispatch switch (owner or dispatch bot only)
  wakeups [--all]                          open wakeups for you (or everyone with --all)
  import <org.json>                        load the compiled org file (agents, teams, channels); idempotent
  task create <bot|none> "<title>" [--project p] [--feature f] [--type t] [--needs cap] [--repo r] [--ship-now] [--body "..."] [--board exo] [--priority N] [--after t_..,t_..]
  task assign <card> <bot> [--project p] [--feature f] [--type t] [--needs cap] [--repo r] [--ship-now]   an existing card becomes the bot's
      --repo: where the code lives; a coding card must name a repo the bots reach. Vault code: <bot> is the vault
      assignee (ORG_VAULT_ASSIGNEE, default vault-session: a Claude Code session on the owner's machine, never a bot)
      with --repo vault; leads, the dispatch bot and the owner give it cards
      --type: research | coding | design | media | writing | sales | education | ops (what the card's tokens count as on /usage;
      default: the bot's team). coding needs the code capability, ops deploy, research web; --needs names one outright
      (code | review | merge | deploy | m1 | web). A bot without it is refused. --ship-now (owner only): merge and deploy
      without asking
                                           one card, one bot: creates the kanban card tagged with the project, records the link,
                                           posts a mention in the bot's team channel; a human assigns anyone, a lead its team, a member itself
  task list [--project p] [--feature f] [--agent a] [--json]    cards with their project, feature and bot
  task redo <review card> "<what to change>"   changes requested: a new round for the builder, the review card parked until it is done
                                           (two rounds, then the lead is told instead)
  graph list                               the card templates (.agents/org/graphs/*.yaml, compiled)
  graph apply <template> --project p [--feature f] [--team t] [--board exo] [--dry-run] [--json]
                                           one card per node for the project's team, each waiting on its parents; roots are mentioned

  model routing (docs/org-routing.md; the config is .agents/org/routing.json, written by compile.py routing):
  route decide --work <type> [--role work|review|merge|deploy] --tiers t1,t2 [--files N] [--path] [--spec low|ok] [--risk high] [--card ID (reads its earlier failures)] [--down providers]
        [--text "<card text>"] [--author-tier t2] [--failures turn_cap_no_commit,tests_failed,review_changes,blocked]
        [--down provider,..] [--config file] [--record --agent a [--card t_..] [--run id]] [--json]   pick the model; nothing is run
  route outcome <decision id> <merged|rejected|parked|blocked|done|failed> [--turns N] [--tokens N] [--cost usd] [--from tier] [--verified]
  route report [--days 7] [--json]                       escalation rate and cost per merged PR by tier

  shipping (nothing merges or deploys without the owner's yes, unless the owner made the card --ship-now):
  ship request <card> "<summary>" [--pr <github pr url>] [--deploy <target>]   ask the owner; a ship-now card is approved at once
  ship approve <id> [--note "..."] | ship deny <id> "<why>"                  the owner only, never inside a bot run
  ship check <card> [--pr url] [--deploy target]                             exit 0 when it may ship (the wrappers ask this)
  ship list [--pending] [--card t_..]

  shared memory (every runtime, same verbs):
  recall "<query>" [--project p] [--limit N] [--json]    the vault (keyword + vector), the bots' memory files, shared facts
  remember "<subject>" "<claim>" --source <path|#msg|t_card|url> [--project p] [--inferred] [--supersedes id] [--via runtime@host]
  facts [--subject s] [--project p] [--author a] [--all] [--json]
  forget <id> "<why>"                                    close a fact (its author, the author's lead or the owner)

  persona memory (docs/agent-memory.md; each bot's own, written by the reflect step after its wakes, read on /org/agents/<name>):
  memory <agent> [--all] [--json]          the bot's active lessons (its core block's rows); --all includes closed ones
  memory episodes <agent> [--limit N]      its finished wakes: outcome, corrected, turns, cost
  memory stats <agent> [--days N]          corrections and cost per completed card (the ledger's metric), memory counts
  memory edit <id> "<new text>"            the owner or the bot's lead corrects a line (the old row is closed, never deleted)
  memory retire <id> "<why>"               close a line that no longer holds
  reflect <agent> --run R [--wakeups 1,2] [--task t_..] [--reason task|chat|..] [--outcome done|blocked|..] [--exit N]
          [--result "..."] [--turns N] [--cost USD] [--duration S] [--log path] [--transcript path] [--dry-run]
                                           record the episode and, when configured, the cheap-model reflection (wake-done does this)
  propose-improvement <agent> --memory-id <id> [--dry-run]   one self-improvement card from a recurring friction; a human applies it

  dispatcher only (cc-dispatcher runs these as hermes):
  wake-claim <agent> --by <run id> --json  claim every open wakeup of the agent; prints them
  wake-done <id,id> [--run R] [--exit N] [--result "..."] [--turns N] [--cost USD] [--duration S] [--log path] [--transcript path]
                                           mark done; posts a fallback status if the run left none; records the episode and reflects
  wake-add <agent> --reason routine|owner|task --ref X      a wakeup the trigger doesn't make (no-op if one is open,
                                           or if the card is held: it keeps waking the bot without finishing)
  session <agent> [--set <id> | --clear]   the claude session id the agent resumes (dropped after ORG_SESSION_MAX_RUNS runs)
  wake-release                             un-claim every claimed, unfinished wakeup (the dispatcher restarted; their runs died)

  @name in a body mentions an agent and wakes it if it is in the channel. --json prints records for the app and tests.
  ORG_RUN tags posts with the run id. ORG_NOTIFY_CMD is the urgent-question notifier (default: deploy/org-notify.sh).
  With ORG_AGENT set and SB_ORG_DB_URL in the environment, the connection is the sb_org role with row-level
  security keyed on the agent's name; the dispatcher commands (no ORG_AGENT) keep the owner's connection.`;

/** The agent's connection: the RLS role, with its name in the `org.agent` startup option every policy reads. */
export function agentDatabaseUrl(base: string, agent: string): string {
  const u = new URL(base);
  u.searchParams.set('options', `-c org.agent=${agent}`);
  return u.toString();
}

type Args = { pos: string[]; opts: Record<string, string | true> };

export function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else {
      opts[key] = next;
      i++;
    }
  }
  return { pos, opts };
}

export function identityName(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.ORG_AGENT?.trim();
  if (!name) throw new OrgError('ORG_AGENT is not set; the dispatcher sets it, the owner uses their own org name (ORG_OWNER)');
  return name;
}

/** "24h", "3d", "90m" → hours. */
export function parseSince(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([hdm])$/.exec(s.trim());
  if (!m) throw new OrgError(`--since takes 24h, 3d or 90m, not "${s}"`);
  const n = Number(m[1]);
  return m[2] === 'd' ? n * 24 : m[2] === 'm' ? n / 60 : n;
}

function when(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function formatMessage(m: Message): string {
  const flags = [m.urgent ? 'URGENT' : '', m.thread_id ? `re:${m.thread_id}` : '', m.task_id ? `task ${m.task_id}` : '', m.project_slug ? `project ${m.project_slug}${m.feature_slug ? `/${m.feature_slug}` : ''}` : '']
    .filter(Boolean)
    .join(' ');
  const head = `#${m.channel_slug} ${m.id} ${when(new Date(m.created_at))} ${m.author} [${m.kind}]${flags ? ` (${flags})` : ''}`;
  const body = m.body.split('\n').map((l) => `  ${l}`).join('\n');
  return `${head}\n${body}`;
}

function str(v: string | true | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: string | true | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  if (v === true || !/^\d+$/.test(v)) throw new OrgError(`--${flag} needs a number`);
  return Number(v);
}

function dec(v: string | true | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  if (v === true || !/^\d+(\.\d+)?$/.test(v)) throw new OrgError(`--${flag} needs a number`);
  return Number(v);
}

function here(): string {
  return resolve(fileURLToPath(import.meta.url), '..');
}

function formatMemory(m: MemoryRow): string {
  return `#${m.id} [${m.kind}, ×${m.occurrences}, ${when(new Date(m.updated_at))}${m.active ? '' : `, closed: ${m.retired_why ?? ''}`}${m.proposal_task_id ? `, proposed ${m.proposal_task_id}` : ''}] ${m.content}`;
}

/** What wake-done and reflect print: the episode, then what the reflection did, or why it did nothing. */
export function formatReflect(r: ReflectResult): string {
  const lines = [`episode #${r.episode.id} ${r.created ? 'recorded' : 'already recorded'} (${r.episode.outcome}${r.episode.turn_count !== null ? `, ${r.episode.turn_count} turns` : ''})`];
  if (r.skipped) lines.push(`reflect: skipped (${r.skipped})`);
  else if (r.applied) {
    const a = r.applied;
    lines.push(`reflect: ${a.added.length} added, ${a.bumped.length} bumped, ${a.superseded.length} reworded, ${a.retired.length} closed${a.dropped.length ? `; dropped: ${a.dropped.join('; ')}` : ''}`);
    for (const m of [...a.added, ...a.bumped, ...a.superseded]) lines.push(`  ${formatMemory(m)}`);
  } else lines.push(`reflect (dry run): ${JSON.stringify(r.ops)}`);
  if (r.core) lines.push(`core: ${r.core.path} (${r.core.kept.length} lines${r.core.dropped.length ? `, ${r.core.dropped.length} over budget` : ''})`);
  for (const p of r.proposals) lines.push(p.card ? `proposal: card ${p.card.id} (memory #${p.memory_id})` : `proposal for memory #${p.memory_id}: ${p.refused}`);
  return lines.join('\n');
}

export function reflectSummary(r: ReflectResult): Record<string, unknown> {
  return {
    episode_id: r.episode.id, created: r.created, outcome: r.episode.outcome, reflected: r.reflected, skipped: r.skipped, ops: r.ops,
    added: r.applied?.added.map((m) => m.id) ?? [], bumped: r.applied?.bumped.map((m) => m.id) ?? [], superseded: r.applied?.superseded.map((m) => m.id) ?? [],
    retired: r.applied?.retired ?? [], dropped: r.applied?.dropped ?? [], core: r.core, proposals: r.proposals.map((p) => ({ memory_id: p.memory_id, card: p.card?.id ?? null, refused: p.refused })),
  };
}

/** After an edit the generated core block is stale; re-render it from the rows (a no-op without the vault here). */
async function rerenderCore(agent: string): Promise<void> {
  await writeCore(config.vaultRoot, agent, memorySettingsFor(config.vaultRoot, agent).memory.core_budget_tokens).catch(() => null);
}

function formatTask(t: TaskLink): string {
  return `${t.task_id}  ${t.assignee.padEnd(8)} ${(t.project_slug ?? '-') + (t.feature_slug ? `/${t.feature_slug}` : '')}${t.work_type ? `  [${t.work_type}]` : ''}  ${t.title}  (by ${t.created_by}, ${when(new Date(t.created_at))})`;
}

/** Runs the urgent notifier with the text; a failure is reported, never fatal (the message is already on the board). */
export function notifyOwner(text: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const cmd = env.ORG_NOTIFY_CMD ?? resolve(here(), '..', '..', 'deploy', 'org-notify.sh');
  if (!existsSync(cmd)) return Promise.resolve(`urgent: no notifier at ${cmd}; the question is on the board and in the stand-up`);
  return new Promise((done) => {
    execFile(cmd, [text], { env, timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) done(`urgent: notifier failed (${err.message.split('\n')[0]}); the question is on the board and in the stand-up${stderr ? `\n${stderr.trim()}` : ''}`);
      else done(`urgent: sent to the owner's phone${stdout.trim() ? ` (${stdout.trim()})` : ''}`);
    });
  });
}

function formatApproval(a: Approval): string {
  return `#${a.id} ${a.status.padEnd(8)} ${a.task_id} by ${a.requested_by}${a.pr_url ? ` ${a.pr_url}` : ''}${a.deploy_target ? ` deploy ${a.deploy_target}` : ''}${a.ship_now ? ' [ship-now]' : ''}  ${a.summary.slice(0, 120)}${a.decided_by ? `  (${a.decided_by} ${when(new Date(a.decided_at!))})` : ''}`;
}

function formatFact(f: Fact): string {
  return `#${f.id} ${f.subject}: ${f.claim}  [${f.confidence}, ${f.source}, ${f.author}${f.via ? ` via ${f.via}` : ''}, ${when(new Date(f.valid_from))}${f.valid_to ? `, closed ${when(new Date(f.valid_to))}${f.retired_why ? `: ${f.retired_why}` : ''}` : ''}]`;
}

/** A search snippet as plain text for a model: no highlight tags, entities decoded (they cost tokens and mean nothing). */
export function plainSnippet(html: string): string {
  return html
    .replace(/<\/?(?:b|mark|em|strong)>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * The vault side of recall: hybrid (keyword + vector) when embeddings are configured, else keyword, over-fetched and
 * filtered so the owner's working files and finances never come back. Runs on the app's connection: the index
 * isn't the board, so the sb_org role has no grant on it.
 */
export async function recallVault(q: string, limit: number, env: NodeJS.ProcessEnv = process.env): Promise<RecallHit[]> {
  const extra = (env.ORG_RECALL_EXCLUDE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const floor = Number(env.ORG_RECALL_MIN_SIMILARITY);
  const minSimilarity = Number.isFinite(floor) && floor > 0 ? floor : DEFAULT_RECALL_MIN_SIMILARITY;
  let hits: VaultSearchHit[] = [];
  try {
    await loadEmbeddingConfig();
    hits = (await hybridSearch(q, { source: 'vault', limit: limit * 3, offset: 0, provider: defaultEmbeddingProvider(), minSimilarity })).results;
  } catch {
    try {
      hits = (await search(q, { source: 'vault', limit: limit * 3, offset: 0 })).results;
    } catch {
      return [];
    }
  }
  const kept = shapeVaultHits(hits.filter((h) => !recallExcluded(h.ref_path, extra)), limit, minSimilarity)
    .map((h) => ({ source: 'vault' as const, ref: h.ref_path, title: h.title ?? '', text: plainSnippet(h.snippet), score: Number(h.rank) }));
  return dedupeVaultHits(kept).slice(0, limit);
}

async function main(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest);
  const json = opts.json === true;
  const run = process.env.ORG_RUN;
  // recall searches the vault on the app's own connection first (sb_org can't read the vault index), then switches.
  const vaultHits = cmd === 'recall' && pos[0] ? await recallVault(pos[0], num(opts.limit, 'limit') ?? 8) : null;
  if (process.env.ORG_AGENT?.trim() && process.env.SB_ORG_DB_URL) setDatabaseUrl(agentDatabaseUrl(process.env.SB_ORG_DB_URL, identityName()));
  const me = async (): Promise<Agent> => getAgent(identityName());
  const print = (ms: Message[], empty: string): void => {
    if (json) out(JSON.stringify(ms, null, 2));
    else out(ms.length ? ms.map(formatMessage).join('\n') : empty);
  };

  switch (cmd) {
    case 'whoami': {
      const w = await whoami(await me());
      if (json) return (out(JSON.stringify(w, null, 2)), 0);
      const a = w.agent;
      out(`${a.name}: ${a.role}${w.team ? ` on ${w.team.name} (${w.team.slug})` : ''}${a.reports_to ? `, reports to ${a.reports_to}` : ''}${w.is_lead ? ', team lead' : ''}${a.runtime === 'human' ? ' [human]' : ''}`);
      if (a.capabilities?.length) out(`capabilities: ${a.capabilities.join(', ')}`);
      if (w.reports.length) out(`reports: ${w.reports.join(', ')}`);
      out(`channels: ${w.channels.map((c) => `#${c.slug}${c.unread ? ` (${c.unread} unread)` : ''}`).join('  ') || 'none'}`);
      out(w.wakeups.length ? `wakeups: ${w.wakeups.map((k) => `${k.reason}${k.ref ? ` ${k.ref}` : ''}`).join(', ')}` : 'wakeups: none');
      return 0;
    }
    case 'read': {
      const agent = await me();
      const kinds = str(opts.kinds)?.split(',').map((s) => s.trim()) as Kind[] | undefined;
      if (kinds) for (const k of kinds) if (!(KINDS as readonly string[]).includes(k)) throw new OrgError(`unknown kind "${k}"`);
      const ms = await readMessages(agent, {
        channel: pos[0],
        unreadOnly: opts.all !== true,
        kinds,
        sinceHours: str(opts.since) ? parseSince(str(opts.since)!) : undefined,
        limit: num(opts.limit, 'limit'),
        mark: opts['no-mark'] !== true,
      });
      print(ms, pos[0] ? `nothing new in #${pos[0]}` : 'nothing new');
      return 0;
    }
    case 'post': {
      const [channel, body] = pos;
      if (!channel || !body) throw new OrgError('post <channel> "<body>"');
      const m = await post(await me(), channel, body, {
        kind: str(opts.kind) as Kind | undefined,
        thread: num(opts.thread, 'thread'),
        task: str(opts.task),
        project: str(opts.project),
        feature: str(opts.feature),
        run,
      });
      out(json ? JSON.stringify(m) : `posted ${m.id} in #${m.channel_slug}${m.mentions.length ? ` (mentions ${m.mentions.join(', ')})` : ''}`);
      return 0;
    }
    case 'dm': {
      const [to, body] = pos;
      if (!to || !body) throw new OrgError('dm <agent> "<body>"');
      const m = await dm(await me(), to, body, { kind: str(opts.kind) as Kind | undefined, thread: num(opts.thread, 'thread'), task: str(opts.task), run });
      out(json ? JSON.stringify(m) : `sent ${m.id} to ${to}`);
      return 0;
    }
    case 'handoff': {
      const [channel, to, body] = pos;
      if (!channel || !to || !body) throw new OrgError('handoff <channel> <agent> "<body>"');
      const m = await handoff(await me(), channel, to, body, { task: str(opts.task), project: str(opts.project), feature: str(opts.feature), run });
      out(json ? JSON.stringify(m) : `handed off ${m.id} to ${to} in #${channel}`);
      return 0;
    }
    case 'ask-owner': {
      const [body] = pos;
      if (!body) throw new OrgError('ask-owner "<body>"');
      const agent = await me();
      const m = await askOwner(agent, body, { urgent: opts.urgent === true, task: str(opts.task), project: str(opts.project) });
      out(json ? JSON.stringify(m) : `asked ${m.id} in #leads${m.urgent ? ' (urgent)' : ''}`);
      if (m.urgent) out(await notifyOwner(`[org] ${agent.name} asks (#${m.id}): ${m.body}`));
      return 0;
    }
    case 'standup': {
      const [body] = pos;
      if (!body) throw new OrgError('standup "<body>"');
      const m = await standup(await me(), body);
      out(json ? JSON.stringify(m) : `stand-up ${m.id} posted in #${m.channel_slug}`);
      return 0;
    }
    case 'thread': {
      const id = num(pos[0], 'thread');
      if (id === undefined) throw new OrgError('thread <id>');
      print(await getThread(await me(), id), `no messages in thread ${id}`);
      return 0;
    }
    case 'search': {
      if (!pos[0]) throw new OrgError('search "<words>"');
      print(await searchMessages(await me(), pos[0], num(opts.limit, 'limit')), 'no matches');
      return 0;
    }
    case 'channels': {
      const cs = await listChannels(await me());
      if (json) return (out(JSON.stringify(cs, null, 2)), 0);
      for (const c of cs) out(`#${c.slug}  ${c.kind}  ${c.members} members${c.unread ? `  ${c.unread} unread` : ''}${c.purpose ? `  ${c.purpose}` : ''}`);
      return 0;
    }
    case 'agents': {
      const chart = await orgChart();
      if (json) return (out(JSON.stringify(chart, null, 2)), 0);
      for (const a of chart.agents) {
        out(`${a.name.padEnd(10)} ${a.role}${a.team_name ? `  [${a.team_name}${a.is_lead ? ', lead' : ''}]` : ''}${a.reports_to ? `  reports to ${a.reports_to}` : ''}  (${a.runtime}${a.model ? `, ${a.model}` : ''}${a.effort ? `, effort ${a.effort}` : ''}${a.overridden ? ', override' : ''})${a.paused ? `  PAUSED: ${a.paused_reason ?? 'no reason given'}` : ''}`);
      }
      return 0;
    }
    case 'pause':
    case 'resume': {
      const [scope] = pos;
      const reason = str(opts.reason) ?? '';
      const until = str(opts.until);
      if (!scope) throw new OrgError(`${cmd} <agent|team|all> --reason "..." [--until "when"]`);
      const by = identityName();
      const lane = /^lane:(.+)$/.exec(scope)?.[1];
      const n = lane ? await pauseLane(by, lane, cmd === 'pause', reason)
        : cmd === 'pause' ? await pauseAgents(by, scope, true, reason, until) : await resumeAgents(by, scope);
      out(json ? JSON.stringify({ scope, paused: cmd === 'pause', agents: n }) : `${cmd === 'pause' ? 'paused' : 'resumed'} ${n} agent(s) in ${scope}`);
      return 0;
    }
    case 'set': {
      const [agent] = pos;
      if (!agent) throw new OrgError('set <agent> --runtime R --model M [--effort E] | set <agent> --clear');
      const by = identityName();
      if (opts.clear === true) {
        const had = await clearOverride(by, agent);
        out(json ? JSON.stringify({ agent, cleared: had }) : had ? `${agent}: override cleared; org.yaml applies again` : `${agent}: no override to clear`);
        return 0;
      }
      const o = await setOverride(by, agent, { runtime: str(opts.runtime), model: str(opts.model), effort: str(opts.effort) });
      out(json ? JSON.stringify(o) : `${agent}: override set (${[o.runtime && `runtime ${o.runtime}`, o.model && `model ${o.model}`, o.effort && `effort ${o.effort}`].filter(Boolean).join(', ')}); applies on the next claim`);
      return 0;
    }
    case 'overrides': {
      const os = await listOverrides();
      if (json) return (out(JSON.stringify(os, null, 2)), 0);
      out(os.length ? os.map((o) => `${o.agent.padEnd(10)} ${[o.runtime, o.model, o.effort && `effort ${o.effort}`].filter(Boolean).join(' ')}  set by ${o.set_by} ${when(new Date(o.set_at))}`).join('\n') : 'no overrides');
      return 0;
    }
    case 'breaker': {
      // The credit breaker: run from the dispatcher's tick, or by hand with --dry-run to see what it would pause.
      const acts = await runBreaker(identityName(), breakerLimitsFromEnv(), { dryRun: opts['dry-run'] === true });
      if (json) return (out(JSON.stringify(acts)), 0);
      out(acts.length ? acts.map((a) => `${a.runtime}: ${a.reason} (${opts['dry-run'] === true ? 'dry run' : `${a.paused} bot(s) paused`})`).join('\n') : 'breaker: nothing to pause');
      return 0;
    }
    case 'board': {
      const [sub, arg] = pos;
      const by = identityName();
      if (sub === 'pause' || sub === 'resume') {
        const enabled = sub === 'resume';
        const reason = str(opts.reason);
        if (!enabled && !(reason && reason.trim())) throw new OrgError('board pause --reason "..." (a disabled board needs a reason)');
        const st = await setDispatch(by, enabled, reason);
        out(json ? JSON.stringify(st) : `dispatch ${st.dispatch_enabled ? 'enabled' : `disabled (${st.disabled_reason})`} on ${st.board_slug}`);
        return 0;
      }
      if (sub === 'status' || sub === undefined) {
        const st = await dispatchState(arg ?? 'exo');
        out(json ? JSON.stringify(st) : `${st.board_slug}: dispatch ${st.dispatch_enabled ? 'enabled' : `disabled (${st.disabled_reason})`}`);
        return 0;
      }
      throw new OrgError('board <status|pause|resume> [board] [--reason "..."]');
    }
    case 'wakeups': {
      const ws = await openWakeups(opts.all === true ? undefined : identityName());
      if (json) return (out(JSON.stringify(ws, null, 2)), 0);
      out(ws.length ? ws.map((w) => `${w.id} ${w.agent_name} ${w.reason}${w.ref ? ` ${w.ref}` : ''} ${when(new Date(w.created_at))}${w.claimed_at ? ' claimed' : ''}`).join('\n') : 'no open wakeups');
      return 0;
    }
    case 'wake-claim': {
      const [agent] = pos;
      const by = str(opts.by);
      if (!agent || !by) throw new OrgError('wake-claim <agent> --by <run id>');
      const ws = await claimWakeups(agent, by);
      out(json ? JSON.stringify(ws) : ws.length ? ws.map((w) => `${w.id} ${w.reason}${w.ref ? ` ${w.ref}` : ''}`).join('\n') : 'no open wakeups');
      return 0;
    }
    case 'wake-done': {
      const ids = (pos[0] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!ids.length || ids.some((x) => !/^\d+$/.test(x))) throw new OrgError('wake-done <id,id> [--run R] [--exit N] [--result "..."]');
      const r = await finishWakeups(ids.map(Number), { run: str(opts.run), exit: num(opts.exit, 'exit'), result: str(opts.result) });
      // The memory write pipeline, after the wake is closed: never before it, never fatal to it.
      let reflected: ReflectResult | null = null;
      let reflectErr: string | null = null;
      if (r.agent && str(opts.run)) {
        try {
          const task = r.wakeups.find((w) => w.reason === 'task' && w.ref)?.ref ?? str(opts.task);
          reflected = await reflect(await getAgent(r.agent), {
            run: str(opts.run)!, wakeupIds: r.wakeups.map((w) => w.id), task: task ?? undefined, reason: r.wakeups[0]?.reason ?? (task ? 'task' : 'owner'),
            exit: num(opts.exit, 'exit'), result: str(opts.result), noReport: r.fallback_posted, turns: num(opts.turns, 'turns'), cost: dec(opts.cost, 'cost'),
            duration: num(opts.duration, 'duration'), log: str(opts.log), transcript: str(opts.transcript),
          });
        } catch (err) {
          reflectErr = err instanceof Error ? err.message : String(err);
        }
      }
      if (json) out(JSON.stringify({ ...r, reflect: reflected ? reflectSummary(reflected) : null, reflect_error: reflectErr }));
      else {
        out(`done ${r.done} wakeup(s)${r.fallback_posted ? '; posted a fallback status' : ''}`);
        if (reflected) out(formatReflect(reflected));
        if (reflectErr) out(`reflect: skipped (${reflectErr})`);
      }
      return 0;
    }
    case 'reflect': {
      const [agent] = pos;
      const runId = str(opts.run);
      if (!agent || !runId) throw new OrgError('reflect <agent> --run <run id> [--task t_..] [--reason r] [--outcome o] [--exit N] [--result "..."] [--turns N] [--cost USD] [--duration S] [--log path] [--transcript path] [--dry-run]');
      const reason = str(opts.reason);
      if (reason && !(EPISODE_REASONS as readonly string[]).includes(reason)) throw new OrgError(`--reason is one of ${EPISODE_REASONS.join(', ')}`);
      const outcome = str(opts.outcome);
      if (outcome && !(OUTCOMES as readonly string[]).includes(outcome)) throw new OrgError(`--outcome is one of ${OUTCOMES.join(', ')}`);
      const r = await reflect(await getAgent(agent), {
        run: runId, wakeupIds: str(opts.wakeups)?.split(',').map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number), task: str(opts.task), reason,
        outcome: outcome as Outcome | undefined, exit: num(opts.exit, 'exit'), result: str(opts.result), turns: num(opts.turns, 'turns'), cost: dec(opts.cost, 'cost'),
        duration: num(opts.duration, 'duration'), log: str(opts.log), transcript: str(opts.transcript), dryRun: opts['dry-run'] === true,
      });
      out(json ? JSON.stringify(reflectSummary(r)) : formatReflect(r));
      return 0;
    }
    case 'memory': {
      const [sub] = pos;
      if (sub === 'edit' || sub === 'retire') {
        const id = num(pos[1], 'id');
        if (id === undefined || !pos[2]) throw new OrgError(`memory ${sub} <id> "<${sub === 'edit' ? 'new text' : 'why'}>"`);
        if (sub === 'edit') {
          const row = await editMemory(await me(), id, pos[2]);
          await rerenderCore(row.agent_name);
          out(json ? JSON.stringify(row) : `memory #${id} closed; #${row.id} replaces it`);
        } else {
          const agentName = await retireMemory(await me(), id, pos[2]);
          await rerenderCore(agentName);
          out(`memory #${id} closed`);
        }
        return 0;
      }
      const agent = sub === 'episodes' || sub === 'stats' ? pos[1] : sub;
      if (!agent) throw new OrgError('memory <agent> [--all] | memory episodes <agent> | memory stats <agent> [--days N] | memory edit <id> "<text>" | memory retire <id> "<why>"');
      await getAgent(agent);
      if (sub === 'episodes') {
        const es = await listEpisodes(agent, num(opts.limit, 'limit') ?? 20);
        if (json) return (out(JSON.stringify(es, null, 2)), 0);
        out(es.length ? es.map((e) => `#${e.id} ${when(new Date(e.created_at))} ${e.reason.padEnd(7)} ${e.outcome.padEnd(15)}${e.corrected ? ' corrected' : ''}${e.turn_count !== null ? ` ${e.turn_count}t` : ''}${e.cost_usd !== null ? ` $${e.cost_usd}` : ''}${e.task_id ? ` ${e.task_id}` : ''} run ${e.run_id}${e.reflected_at ? ' [reflected]' : ''}\n  ${e.summary}`).join('\n') : `no episodes for ${agent} yet`);
        return 0;
      }
      if (sub === 'stats') {
        const st = await memoryStats(agent, num(opts.days, 'days') ?? 14);
        if (json) return (out(JSON.stringify(st, null, 2)), 0);
        out(`${agent}, last ${st.days} days: ${st.episodes} episodes, ${st.done} done, ${st.corrected} corrected (${st.corrections_per_done ?? '-'} per done), cost per done ${st.cost_per_done ?? '-'}, avg turns ${st.avg_turns ?? '-'}, ${st.reflected} reflected`);
        out(`memory: ${st.memory.active} active (${Object.entries(st.memory.by_kind).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}); proposals filed: ${st.proposals}`);
        return 0;
      }
      const rows = await listMemory(agent, { all: opts.all === true, limit: num(opts.limit, 'limit') });
      if (json) return (out(JSON.stringify(rows, null, 2)), 0);
      out(rows.length ? rows.map(formatMemory).join('\n') : `no memory for ${agent} yet (it is written by cli-org reflect after its wakes)`);
      return 0;
    }
    case 'propose-improvement': {
      const [agent] = pos;
      const id = num(opts['memory-id'], 'memory-id');
      if (!agent || id === undefined) throw new OrgError('propose-improvement <agent> --memory-id <id> [--dry-run]');
      const r = await proposeImprovement(await getAgent(agent), id, { dryRun: opts['dry-run'] === true });
      if (json) return (out(JSON.stringify(r)), r.refused ? 3 : 0);
      if (r.refused) out(`not proposed: ${r.refused}`);
      else {
        out(r.card ? `card ${r.card.id} for the owner: ${r.card.title}` : `would propose against ${r.target?.path} (dry run)`);
        if (r.rationale) out(`rationale: ${r.rationale}`);
        if (r.diff) out(r.diff);
      }
      return r.refused ? 3 : 0;
    }
    case 'wake-add': {
      const [agent] = pos;
      const reason = str(opts.reason);
      const ref = str(opts.ref);
      if (!agent || !reason || !ref) throw new OrgError('wake-add <agent> --reason routine|owner|task --ref X');
      if (!['routine', 'owner', 'task'].includes(reason)) throw new OrgError(`wake-add reason must be routine, owner or task, not ${reason}`);
      const id = await addWakeup(agent, reason as 'routine', ref);
      const held = id === null && reason === 'task' ? await taskWakeHold(agent, ref) : null;
      const why = !held ? `${agent} already has an open ${reason} ${ref} wakeup`
        : held.reason === 'cap' ? `${agent}: card ${ref} held for a person (${held.runs} runs in 24 h)`
        : `${agent}: card ${ref} held until ${held.until!.toISOString()} (${held.runs} run(s) in 24 h)`;
      out(json ? JSON.stringify({ id, held }) : id ? `wakeup ${id} for ${agent}` : why);
      return 0;
    }
    case 'session': {
      const [agent] = pos;
      if (!agent) throw new OrgError('session <agent> [--set <id> | --clear]');
      if (opts.clear === true) await setSession(agent, null);
      else if (str(opts.set)) await setSession(agent, str(opts.set)!);
      const sdata = await getSession(agent);
      out(json ? JSON.stringify(sdata) : sdata.session_id ? `${agent}: session ${sdata.session_id} since ${sdata.session_started ? new Date(sdata.session_started).toISOString().slice(0, 10) : '?'}, ${sdata.session_runs} run(s)` : `${agent}: no session`);
      return 0;
    }
    case 'wake-release': {
      const n = await releaseClaimed();
      out(json ? JSON.stringify({ released: n }) : `released ${n} wakeup(s)`);
      return 0;
    }
    case 'task': {
      const [sub] = pos;
      if (sub === 'create') {
        const [, assignee, title] = pos;
        const project = str(opts.project);
        if (!assignee || !title) throw new OrgError('task create <bot|none> "<title>" [--project <slug>] [--feature f] [--body "..."]');
        const r = await createTask(await me(), {
          assignee: assignee === 'none' ? null : assignee, title, project, feature: str(opts.feature), type: str(opts.type), needs: str(opts.needs), shipNow: opts['ship-now'] === true, repo: str(opts.repo),
          body: str(opts.body), board: str(opts.board), priority: num(opts.priority, 'priority'), deps: str(opts.after)?.split(',').map((x) => x.trim()).filter(Boolean), run,
        });
        if (json) out(JSON.stringify(r));
        else out(`card ${r.task_id} ${r.link.assignee ? `for ${r.link.assignee}` : 'unassigned'}: ${r.link.title}${r.link.project_slug ? ` (${r.link.project_slug}${r.link.feature_slug ? `/${r.link.feature_slug}` : ''})` : ''} [${r.card.status}]${r.message ? `; mention ${r.message.id} in #${r.message.channel_slug}` : ''}`);
        return 0;
      }
      if (sub === 'assign') {
        const [, card, assignee] = pos;
        const project = str(opts.project);
        if (!card || !assignee) throw new OrgError('task assign <card> <bot> [--project <slug>] [--feature f]');
        const r = await assignTask(await me(), {
          taskId: card, assignee, project, feature: str(opts.feature), type: str(opts.type), needs: str(opts.needs), shipNow: opts['ship-now'] === true, repo: str(opts.repo), board: str(opts.board), run,
        });
        if (json) out(JSON.stringify(r));
        else out(`card ${r.task_id} now ${r.link.assignee}'s: ${r.link.title}${r.link.project_slug ? ` (${r.link.project_slug}${r.link.feature_slug ? `/${r.link.feature_slug}` : ''})` : ''}${r.message ? `; mention ${r.message.id} in #${r.message.channel_slug}` : ''}`);
        return 0;
      }
      if (sub === 'redo') {
        const [, card, changes] = pos;
        if (!card || !changes) throw new OrgError('task redo <review card> "<what to change>"');
        const r = await redoTask(await me(), card, changes, run);
        if (json) out(JSON.stringify(r));
        else out(r.escalated ? `round ${r.rounds} refused: escalated to the lead${r.message ? ` (message ${r.message.id})` : ''}` : `round ${r.rounds}: card ${r.task_id} for the builder; ${card} waits for it${r.message ? `; mention ${r.message.id}` : ''}`);
        return 0;
      }
      if (sub === 'list') {
        const ts = await listTasks({ project: str(opts.project), feature: str(opts.feature), agent: str(opts.agent), limit: num(opts.limit, 'limit') });
        if (json) out(JSON.stringify(ts, null, 2));
        else out(ts.length ? ts.map(formatTask).join('\n') : 'no cards');
        return 0;
      }
      throw new OrgError('task create|assign|list|redo');
    }
    case 'graph': {
      const [sub, name] = pos;
      const graphs = loadGraphs(config.vaultRoot);
      if (sub === 'list') {
        const all = Object.values(graphs);
        if (json) return (out(JSON.stringify(all, null, 2)), 0);
        out(all.length ? all.map((g) => `${g.name.padEnd(16)} ${g.nodes.map((n) => `${n.id}${n.after.length ? `←${n.after.join(',')}` : ''} (${n.assign})`).join('  ')}${g.description ? `\n${' '.repeat(17)}${g.description}` : ''}`).join('\n') : `no graph templates in ${config.vaultRoot}/.agents/org/graphs.json (compile.py graphs)`);
        return 0;
      }
      if (sub === 'apply') {
        const project = str(opts.project);
        if (!name || !project) throw new OrgError('graph apply <template> --project <slug> [--feature f] [--team t] [--dry-run]');
        const g = graphs[name];
        if (!g) throw new OrgError(`no graph template "${name}" (cli-org graph list)`);
        const r = await applyGraph(await me(), g, { project, feature: str(opts.feature), team: str(opts.team), board: str(opts.board), dryRun: opts['dry-run'] === true, run });
        if (json) out(JSON.stringify(r));
        else {
          out(`${opts['dry-run'] === true ? 'would create' : 'created'} ${r.cards.length} cards for ${project}${str(opts.feature) ? `/${str(opts.feature)}` : ''} (${name}):`);
          for (const c of r.cards) out(`  ${c.task_id ?? '-'}  ${c.node.padEnd(8)} ${c.kind.padEnd(7)} ${c.assignee.padEnd(8)} ${c.title}${c.after.length ? `  after ${c.after.join(', ')}` : ''}`);
          if (r.message) out(`posted ${r.message.id} in #${r.message.channel_slug}`);
        }
        return 0;
      }
      throw new OrgError('graph list|apply');
    }
    case 'ship': {
      const [sub, a1, a2] = pos;
      if (sub === 'request') {
        if (!a1 || !a2) throw new OrgError('ship request <card> "<summary>" [--pr url] [--deploy target]');
        const r = await shipRequest(await me(), { card: a1, summary: a2, pr: str(opts.pr), deploy: str(opts.deploy) });
        if (json) return (out(JSON.stringify(r)), 0);
        const a = r.approval;
        if (a.status === 'approved') out(`ship #${a.id} approved at once (${a.note ?? 'ship-now'}); go ahead`);
        else if (!r.created) out(`ship #${a.id} is already waiting on the owner; nothing new sent`);
        else {
          out(`ship #${a.id} asked${r.message ? ` (message ${r.message.id} in #${r.message.channel_slug})` : ''}; block the card until the answer wakes you`);
          out(await notifyOwner(shipNotice(a)));
        }
        return 0;
      }
      if (sub === 'approve' || sub === 'deny') {
        const id = num(a1, 'id');
        if (id === undefined) throw new OrgError(`ship ${sub} <id>${sub === 'deny' ? ' "<why>"' : ''}`);
        const a = await shipDecide(await me(), id, sub === 'approve', sub === 'deny' ? a2 : str(opts.note));
        out(json ? JSON.stringify(a) : `ship #${a.id} ${a.status}; ${a.requested_by} is woken with the answer`);
        return 0;
      }
      if (sub === 'check') {
        if (!a1) throw new OrgError('ship check <card> [--pr url] [--deploy target]');
        const r = await shipCheck(a1, { pr: str(opts.pr), deploy: str(opts.deploy) });
        out(json ? JSON.stringify(r) : `${r.ok ? 'ok' : 'no'}: ${r.reason}`);
        return r.ok ? 0 : 3;
      }
      if (sub === 'list') {
        const as = await listApprovals({ pending: opts.pending === true, card: str(opts.card), limit: num(opts.limit, 'limit') });
        if (json) return (out(JSON.stringify(as, null, 2)), 0);
        out(as.length ? as.map(formatApproval).join('\n') : 'no approvals');
        return 0;
      }
      throw new OrgError('ship request|approve|deny|check|list');
    }
    case 'recall': {
      const [q] = pos;
      if (!q) throw new OrgError('recall "<query>" [--project p] [--limit N]');
      const limit = num(opts.limit, 'limit') ?? 8;
      const hits: RecallHit[] = [
        ...(await recallFacts(q, { project: str(opts.project), limit })),
        ...recallMemoryFiles(config.vaultRoot, q, Math.ceil(limit / 2)),
        ...(vaultHits ?? []),
      ];
      if (json) return (out(JSON.stringify(hits, null, 2)), 0);
      if (!hits.length) return (out('nothing found; try other words, or it is not written down yet'), 0);
      for (const h of hits) out(`[${h.source}] ${h.ref}${h.title && h.source !== 'memory' ? `  ${h.title}` : ''}\n  ${h.text.replace(/\s+/g, ' ').slice(0, 400)}`);
      return 0;
    }
    case 'remember': {
      const [subject, claim] = pos;
      const source = str(opts.source);
      if (!subject || !claim || !source) throw new OrgError('remember "<subject>" "<claim>" --source <path|#msg|t_card|url> [--project p] [--inferred] [--supersedes id]');
      const f = await remember(await me(), {
        subject, claim, source, project: str(opts.project), inferred: opts.inferred === true, supersedes: num(opts.supersedes, 'supersedes'),
        via: str(opts.via) ?? process.env.ORG_VIA,
      });
      out(json ? JSON.stringify(f) : `fact #${f.id} saved${f.supersedes ? ` (closes #${f.supersedes})` : ''}`);
      return 0;
    }
    case 'facts': {
      const fs = await listFacts({ subject: str(opts.subject), project: str(opts.project), author: str(opts.author), all: opts.all === true, limit: num(opts.limit, 'limit') });
      if (json) return (out(JSON.stringify(fs, null, 2)), 0);
      out(fs.length ? fs.map(formatFact).join('\n') : 'no facts');
      return 0;
    }
    case 'forget': {
      const id = num(pos[0], 'id');
      if (id === undefined || !pos[1]) throw new OrgError('forget <id> "<why>"');
      await forget(await me(), id, pos[1]);
      out(`fact #${id} closed`);
      return 0;
    }
    case 'route': {
      const [sub] = pos;
      if (sub === 'decide') {
        const file = str(opts.config) ?? process.env.ORG_ROUTING_JSON ?? resolve('.agents/org/routing.json');
        if (!existsSync(file)) throw new OrgError(`no routing config at ${file}; run compile.py routing or pass --config`);
        const cfg = JSON.parse(readFileSync(file, 'utf8')) as RoutingConfig;
        const tiers = (str(opts.tiers) ?? '').split(',').map((t) => t.trim()).filter(Boolean) as Tier[];
        if (!tiers.length || tiers.some((t) => !(TIERS as readonly string[]).includes(t))) throw new OrgError(`--tiers takes a list from ${TIERS.join(', ')}`);
        const work = str(opts.work);
        if (!work) throw new OrgError('route decide --work <type> --tiers t1,t2 [...]');
        const role = (str(opts.role) ?? 'work') as 'work' | 'review' | 'merge' | 'deploy';
        if (!['work', 'review', 'merge', 'deploy'].includes(role)) throw new OrgError('--role: work, review, merge or deploy');
        const authorTier = str(opts['author-tier']) as Tier | undefined;
        if (authorTier && !(TIERS as readonly string[]).includes(authorTier)) throw new OrgError(`--author-tier: one of ${TIERS.join(', ')}`);
        const d = decide(
          {
            work, role, text: str(opts.text), files: num(opts.files, 'files'), namedPath: opts.path === true, specClarity: str(opts.spec) === 'low' ? 'low' : 'ok',
            risk: str(opts.risk) === 'high' ? 'high' : 'normal', envelope: tiers, authorTier,
            failures: (str(opts.failures) !== undefined ? str(opts.failures)!.split(',').map((f) => f.trim()).filter(Boolean) : str(opts.card) ? await cardFailures(str(opts.card)!) : []) as Failure[],
            unhealthyProviders: str(opts.down)?.split(',').map((x) => x.trim()).filter(Boolean),
          },
          cfg,
        );
        const id = opts.record === true ? await recordDecision({ runId: str(opts.run) ?? run, cardId: str(opts.card), agent: str(opts.agent) ?? identityName(), d }) : undefined;
        if (json) out(JSON.stringify({ ...d, decision_id: id }, null, 2));
        else out(d.action === 'run' ? `run ${d.model} (${d.tier}, ${d.turns} turns): ${d.reason}${id ? ` [decision ${id}]` : ''}` : `${d.action}: ${d.reason}${id ? ` [decision ${id}]` : ''}`);
        return d.action === 'run' ? 0 : 2;
      }
      if (sub === 'outcome') {
        const [, id, result] = pos;
        if (!id || !/^\d+$/.test(id) || !['merged', 'rejected', 'parked', 'blocked', 'done', 'failed'].includes(result ?? '')) throw new OrgError('route outcome <decision id> <merged|rejected|parked|blocked|done|failed> [--turns N] [--tokens N] [--cost usd] [--from tier] [--verified]');
        await recordOutcome({ decisionId: Number(id), result: result as Result, turns: num(opts.turns, 'turns'), tokens: num(opts.tokens, 'tokens'), costUsd: dec(opts.cost, 'cost'), escalatedFrom: str(opts.from) as Tier | undefined, verified: opts.verified === true });
        out(`decision ${id}: ${result}`);
        return 0;
      }
      if (sub === 'report') {
        const rows = await routeReport(num(opts.days, 'days') ?? 7);
        if (json) out(JSON.stringify(rows, null, 2));
        else out(rows.length ? rows.map((r) => `${r.tier}: ${r.decisions} runs, ${r.escalated} escalated, ${r.merged} merged, cost ${r.cost_usd ?? 'unknown'} USD, per merged ${r.cost_per_merged_usd ?? 'unknown'} USD`).join('\n') : 'no routed runs in that window');
        return 0;
      }
      throw new OrgError('route decide|outcome|report');
    }
    case 'import': {
      if (!pos[0]) throw new OrgError('import <org.json>');
      const r = await importOrg(JSON.parse(readFileSync(pos[0], 'utf8')));
      out(`imported ${r.agents} agents, ${r.teams} teams, ${r.channels} channels${r.retired ? `, retired ${r.retired}` : ''}`);
      return 0;
    }
    default:
      out(USAGE);
      return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1;
  }
}

export { main };

if (process.argv[1]?.endsWith('cli-org.js') || process.argv[1]?.endsWith('cli-org.ts')) {
  let code = 1;
  try {
    code = await main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof OrgError) console.error(err.message);
    else if (err instanceof z.ZodError) console.error(err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('\n'));
    else console.error(err instanceof Error ? err.message : String(err));
  } finally {
    await pool.end();
  }
  process.exit(code);
}
