import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from './config.js';
import { pool, setDatabaseUrl } from './db.js';
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
  type KanbanRunner,
  type Kind,
  type Message,
  type TaskLink,
} from './org.js';
import {
  forget,
  listApprovals,
  listFacts,
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
} from './org-powers.js';
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
  wakeups [--all]                          open wakeups for you (or everyone with --all)
  import <org.json>                        load the compiled org file (agents, teams, channels); idempotent
  task create <bot> "<title>" --project p [--feature f] [--type t] [--needs cap] [--repo r] [--ship-now] [--body "..."] [--board exo] [--priority N]
  task assign <card> <bot> --project p [--feature f] [--type t] [--needs cap] [--repo r] [--ship-now] [--board exo]   an existing card becomes the bot's
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

  dispatcher only (cc-dispatcher runs these as hermes):
  wake-claim <agent> --by <run id> --json  claim every open wakeup of the agent; prints them
  wake-done <id,id> [--run R] [--exit N] [--result "..."]   mark done; posts a fallback status if the run left none
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

function here(): string {
  return resolve(fileURLToPath(import.meta.url), '..');
}

/** `hermes kanban …` for `task create`; ORG_KANBAN_CMD overrides the binary (tests, agent-hub). */
export function kanbanRunner(env: NodeJS.ProcessEnv = process.env): KanbanRunner {
  const cmd = env.ORG_KANBAN_CMD ?? 'hermes';
  return (args) =>
    new Promise((ok, fail) => {
      execFile(cmd, args, { env, timeout: 30_000, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
        if (err) fail(new OrgError(`kanban: ${(stderr || err.message).trim().slice(0, 300)}`));
        else ok(stdout);
      });
    });
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
  let hits: { ref_path: string; title: string | null; snippet: string; rank: number }[] = [];
  try {
    await loadEmbeddingConfig();
    hits = (await hybridSearch(q, { source: 'vault', limit: limit * 3, offset: 0, provider: defaultEmbeddingProvider() })).results;
  } catch {
    try {
      hits = (await search(q, { source: 'vault', limit: limit * 3, offset: 0 })).results;
    } catch {
      return [];
    }
  }
  return hits
    .filter((h) => !recallExcluded(h.ref_path, extra))
    .slice(0, limit)
    .map((h) => ({ source: 'vault' as const, ref: h.ref_path, title: h.title ?? '', text: plainSnippet(h.snippet), score: Number(h.rank) }));
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
        out(`${a.name.padEnd(10)} ${a.role}${a.team_name ? `  [${a.team_name}${a.is_lead ? ', lead' : ''}]` : ''}${a.reports_to ? `  reports to ${a.reports_to}` : ''}  (${a.runtime}${a.model ? `, ${a.model}` : ''})`);
      }
      return 0;
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
      out(json ? JSON.stringify(r) : `done ${r.done} wakeup(s)${r.fallback_posted ? '; posted a fallback status' : ''}`);
      return 0;
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
        if (!assignee || !title || !project) throw new OrgError('task create <bot> "<title>" --project <slug> [--feature f] [--body "..."]');
        const r = await createTask(await me(), {
          assignee, title, project, feature: str(opts.feature), type: str(opts.type), needs: str(opts.needs), shipNow: opts['ship-now'] === true, repo: str(opts.repo),
          body: str(opts.body), board: str(opts.board), priority: num(opts.priority, 'priority'), run,
        }, kanbanRunner());
        if (json) out(JSON.stringify(r));
        else out(`card ${r.task_id} for ${r.link.assignee}: ${r.link.title} (${r.link.project_slug}${r.link.feature_slug ? `/${r.link.feature_slug}` : ''})${r.message ? `; mention ${r.message.id} in #${r.message.channel_slug}` : ''}`);
        return 0;
      }
      if (sub === 'assign') {
        const [, card, assignee] = pos;
        const project = str(opts.project);
        if (!card || !assignee || !project) throw new OrgError('task assign <card> <bot> --project <slug> [--feature f] [--board exo]');
        const r = await assignTask(await me(), {
          taskId: card, assignee, project, feature: str(opts.feature), type: str(opts.type), needs: str(opts.needs), shipNow: opts['ship-now'] === true, repo: str(opts.repo), board: str(opts.board), run,
        }, kanbanRunner());
        if (json) out(JSON.stringify(r));
        else out(`card ${r.task_id} now ${r.link.assignee}'s: ${r.link.title} (${r.link.project_slug}${r.link.feature_slug ? `/${r.link.feature_slug}` : ''})${r.message ? `; mention ${r.message.id} in #${r.message.channel_slug}` : ''}`);
        return 0;
      }
      if (sub === 'redo') {
        const [, card, changes] = pos;
        if (!card || !changes) throw new OrgError('task redo <review card> "<what to change>"');
        const r = await redoTask(await me(), card, changes, kanbanRunner(), run);
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
        const r = await applyGraph(await me(), g, { project, feature: str(opts.feature), team: str(opts.team), board: str(opts.board), dryRun: opts['dry-run'] === true, run }, kanbanRunner());
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
