import { exitFlushed } from './cli-exit.js';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config } from './config.js';
import { pool, setDatabaseUrl } from './db.js';
import { cardFailures } from './addons/dispatch/store.js';
import { classifyCard, loadCard } from './addons/classify/org-classify.js';
import { decide, recordDecision, recordOutcome, routeReport, routeReportMarkdown, routeSpend, routeWeekly, TIERS, type Failure, type Result, type RoutingConfig, type Tier } from './addons/routing/org-router.js';
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
import { generateAvatar, setAvatar, subjectsFromDb, subjectsFromOrgFile } from './org-avatars.js';
import { applyOrg, formatApply, formatPlan, planOrgFile } from './org-apply.js';
import { main as compileMain } from './cli-org-compile.js';
import { clearOverride, dispatchState, listOverrides, pauseAgents, pauseLane, resumeAgents, setDispatch, setOverride } from './board.js';
import { breakerLimitsFromEnv, runBreaker } from './breaker.js';
import {
  forget,
  listApprovals,
  listFacts,
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
import {
  listEpisodes,
  memoryStats,
  recordEpisode,
  type Episode,
} from './org-memory.js';
import { search } from './search.js';
import { settings } from './settings.js';

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
  plan <org.json> [--prune] [--json]       dry run: what apply would add, change, retire and archive; changes nothing
  apply <org.json> [--prune] [--sha <git sha>] [--by <name>] [--json]
                                           write the file; agents it dropped retire only with --prune (cards to their lead,
                                           pending wakes cancelled); a dropped team is refused while it has members or open cards
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
  route decide --work <type> [--role work|review|merge|deploy] --tiers t1,t2 [--files N] [--path] [--spec low|ok] [--risk high] [--card ID (reads its earlier failures; classifies it when no signal flag is given)] [--down providers]
        [--text "<card text>"] [--author-tier t2] [--failures turn_cap_no_commit,tests_failed,review_changes,blocked]
        [--down provider,..] [--config file] [--record --agent a [--card t_..] [--run id]] [--json]   pick the model; nothing is run
  route outcome <decision id> <merged|rejected|parked|blocked|done|failed> [--turns N] [--tokens N] [--cost usd] [--from tier] [--verified]
  route classify --card <id> [--json]                    the card's signals: scope, named paths, repos, spec clarity, risk flags
  route report [--since 7d | --days 7] [--json | --markdown | --write [file]]   escalation, cost per merged PR, parked/blocked causes, rejections

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

  persona memory (a bot's own claims are memory_facts tagged with its name; use secondbrain memory for those):
  memory episodes <agent> [--limit N]      its finished wakes: outcome, corrected, turns, cost
  memory stats <agent> [--days N]          corrections and cost per completed card (the ledger's metric)

  avatars (docs/org-yaml.md "Avatars"; the image model needs GEMINI_API_KEY):
  avatar show [<name>] [--json]            the portrait path and prompt of one bot, or of every bot
  avatar generate <name>|--all [--force] [--dry-run] [--org <org.json>] [--dir <folder>] [--no-db]
                                           draw the portrait from its avatar_prompt (skips bots whose file exists unless --force);
                                           writes the image under the vault, records the path on the row, prints the org-file line

  dispatcher only (cc-dispatcher runs these as hermes):
  wake-claim <agent> --by <run id> --json  claim every open wakeup of the agent; prints them
  wake-done <id,id> [--run R] [--exit N] [--result "..."] [--turns N] [--cost USD] [--duration S] [--log path] [--transcript path]
                                           mark done; posts a fallback status if the run left none; records the episode
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

// The vault arm of recall (hybrid search, the exclusion list) lives in ./recall.ts, shared with `secondbrain memory`.
import { plainSnippet, recallVault } from './recall.js';

export { plainSnippet, recallVault };

async function main(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest);
  const json = opts.json === true;
  const run = config.env.ORG_RUN;
  // recall searches the vault on the app's own connection first (sb_org can't read the vault index), then switches.
  const vaultHits = cmd === 'recall' && pos[0] ? await recallVault(pos[0], num(opts.limit, 'limit') ?? 8) : null;
  if (config.env.ORG_AGENT?.trim() && config.env.SB_ORG_DB_URL) setDatabaseUrl(agentDatabaseUrl(config.env.SB_ORG_DB_URL, identityName()));
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
      // The episode log, after the wake is closed: never before it, never fatal to it. One row per finished wake.
      let recorded: { episode: Episode; created: boolean } | null = null;
      let episodeErr: string | null = null;
      if (r.agent && str(opts.run)) {
        try {
          const task = r.wakeups.find((w) => w.reason === 'task' && w.ref)?.ref ?? str(opts.task);
          recorded = await recordEpisode(await getAgent(r.agent), {
            run: str(opts.run)!, wakeupIds: r.wakeups.map((w) => w.id), task: task ?? undefined, reason: r.wakeups[0]?.reason ?? (task ? 'task' : 'owner'),
            exit: num(opts.exit, 'exit'), result: str(opts.result), noReport: r.fallback_posted, turns: num(opts.turns, 'turns'), cost: dec(opts.cost, 'cost'),
            duration: num(opts.duration, 'duration'), log: str(opts.log),
          });
        } catch (err) {
          episodeErr = err instanceof Error ? err.message : String(err);
        }
      }
      if (json) out(JSON.stringify({ ...r, episode: recorded?.episode ?? null, episode_created: recorded?.created ?? null, episode_error: episodeErr }));
      else {
        out(`done ${r.done} wakeup(s)${r.fallback_posted ? '; posted a fallback status' : ''}`);
        if (recorded) out(`episode #${recorded.episode.id} ${recorded.created ? 'recorded' : 'already recorded'} (${recorded.episode.outcome}${recorded.episode.turn_count !== null ? `, ${recorded.episode.turn_count} turns` : ''})`);
        if (episodeErr) out(`episode: skipped (${episodeErr})`);
      }
      return 0;
    }
    case 'memory': {
      const [sub] = pos;
      const agent = sub === 'episodes' || sub === 'stats' ? pos[1] : sub;
      if (!agent) throw new OrgError('memory episodes <agent> [--limit N] | memory stats <agent> [--days N]');
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
        out(`${agent}, last ${st.days} days: ${st.episodes} episodes, ${st.done} done, ${st.corrected} corrected (${st.corrections_per_done ?? '-'} per done), cost per done ${st.cost_per_done ?? '-'}, avg turns ${st.avg_turns ?? '-'}`);
        return 0;
      }
      throw new OrgError(`memory: no "${sub ?? ''}" verb; try memory episodes|stats <agent>`);
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
      // Deprecated (one release): the board owns these verbs now. Forward to cli-board with
      // the same flags, so `cli-org task create|assign|redo|list` keeps working until it goes.
      const [sub] = pos;
      console.error('cli-org task is deprecated: use `cli-board create|assign|redo|list` (the board owns these verbs). Forwarding this release.');
      const { main: boardMain } = await import('./cli-board.js');
      const bmain = (a: string[]): Promise<number> => boardMain(a, out);
      const fwd = (keys: string[]): string[] => {
        const fa: string[] = [];
        for (const k of keys) {
          const v = opts[k];
          if (v === undefined) continue;
          if (v === true) fa.push(`--${k}`);
          else fa.push(`--${k}`, v);
        }
        return fa;
      };
      if (sub === 'create') {
        const [, assignee, title] = pos;
        if (!assignee || !title) throw new OrgError('task create <bot|none> "<title>" [--project <slug>] [--feature f] [--body "..."]');
        // `none` and a bot both mean "no --to": cli-board's create leaves an absent --to unassigned.
        return bmain(['create', title, ...(assignee === 'none' ? [] : ['--to', assignee]), ...fwd(['project', 'feature', 'type', 'needs', 'repo', 'priority', 'after', 'body', 'ship-now', 'board', 'kind', 'json'])]);
      }
      if (sub === 'assign') {
        const [, card, assignee] = pos;
        if (!card || !assignee) throw new OrgError('task assign <card> <bot> [--project <slug>] [--feature f]');
        return bmain(['assign', card, assignee, ...fwd(['project', 'feature', 'type', 'needs', 'repo', 'ship-now', 'json'])]);
      }
      if (sub === 'redo') {
        const [, card, changes] = pos;
        if (!card || !changes) throw new OrgError('task redo <review card> "<what to change>"');
        return bmain(['redo', card, changes, ...fwd(['run', 'json'])]);
      }
      if (sub === 'list') {
        const agent = str(opts.agent);
        return bmain(['list', ...fwd(['project', 'feature', 'limit', 'json']), ...(agent ? ['--assignee', agent] : [])]);
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
      console.error('deprecated: use `secondbrain memory recall`; this alias goes in one release.');
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
      console.error('deprecated: use `secondbrain memory remember`; this alias goes in one release.');
      const source = str(opts.source);
      if (!subject || !claim || !source) throw new OrgError('remember "<subject>" "<claim>" --source <path|#msg|t_card|url> [--project p] [--inferred] [--supersedes id]');
      const f = await remember(await me(), {
        subject, claim, source, project: str(opts.project), inferred: opts.inferred === true, supersedes: num(opts.supersedes, 'supersedes'),
        via: str(opts.via) ?? config.env.ORG_VIA,
      });
      out(json ? JSON.stringify(f) : `fact #${f.id} saved${f.supersedes ? ` (closes #${f.supersedes})` : ''}`);
      return 0;
    }
    case 'facts': {
      console.error('deprecated: use `secondbrain memory list`; this alias goes in one release.');
      const fs = await listFacts({ subject: str(opts.subject), project: str(opts.project), author: str(opts.author), all: opts.all === true, limit: num(opts.limit, 'limit') });
      if (json) return (out(JSON.stringify(fs, null, 2)), 0);
      out(fs.length ? fs.map(formatFact).join('\n') : 'no facts');
      return 0;
    }
    case 'forget': {
      const id = num(pos[0], 'id');
      console.error('deprecated: use `secondbrain memory retire`; this alias goes in one release.');
      if (id === undefined || !pos[1]) throw new OrgError('forget <id> "<why>"');
      await forget(await me(), id, pos[1]);
      out(`fact #${id} closed`);
      return 0;
    }
    case 'route': {
      const [sub] = pos;
      if (sub === 'decide') {
        const file = str(opts.config) ?? config.env.ORG_ROUTING_JSON ?? resolve('.agents/org/routing.json');
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
        // A card with no signal flags is read by the classifier, the same as the zen-agent dispatcher does; a flag wins.
        const cardRow = str(opts.card) && [opts.files, opts.path, opts.spec, opts.risk].every((o) => o === undefined) ? await loadCard(str(opts.card)!) : null;
        const sig = cardRow ? await classifyCard(cardRow, settings().dispatch.routing.classifier) : null;
        const d = decide(
          {
            work, role, text: str(opts.text), files: num(opts.files, 'files'), namedPath: opts.path === true, specClarity: str(opts.spec) === 'low' ? 'low' : 'ok',
            risk: str(opts.risk) === 'high' ? 'high' : 'normal',
            ...(sig ? { files: sig.scope, namedPath: sig.namedPath, specClarity: sig.specClarity, risk: sig.risk,
              classified: { source: sig.source, paths: sig.paths, repos: sig.repos, clarity: sig.clarity, riskFlags: sig.riskFlags, ...(sig.note ? { note: sig.note } : {}) } } : {}),
            envelope: tiers, authorTier,
            failures: (str(opts.failures) !== undefined ? str(opts.failures)!.split(',').map((f) => f.trim()).filter(Boolean) : str(opts.card) ? await cardFailures(str(opts.card)!) : []) as Failure[],
            unhealthyProviders: str(opts.down)?.split(',').map((x) => x.trim()).filter(Boolean),
            spend: await routeSpend(str(opts.card) ?? null, cfg),
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
      if (sub === 'classify') {
        const id = str(opts.card);
        if (!id) throw new OrgError('route classify --card <id> [--json]');
        const row = await loadCard(id);
        if (!row) throw new OrgError(`no card ${id}`);
        const sig = await classifyCard(row, settings().dispatch.routing.classifier);
        if (json) out(JSON.stringify(sig, null, 2));
        else out([
          `${id} (${sig.work}): scope ${sig.scope}, ${sig.repos} repo(s), spec ${sig.specClarity}${sig.clarity.length ? ` (${sig.clarity.join(', ')})` : ''}, risk ${sig.risk}${sig.riskFlags.length ? ` (${sig.riskFlags.join(', ')})` : ''} [${sig.source}]`,
          ...(sig.paths.length ? [`paths: ${sig.paths.join(', ')}`] : []),
          ...(sig.note ? [sig.note] : []),
        ].join('\n'));
        return 0;
      }
      if (sub === 'report') {
        const since = str(opts.since);
        if (since !== undefined && !/^\d+d$/.test(since)) throw new OrgError('--since takes a number of days, e.g. 7d');
        const days = since ? Number(since.slice(0, -1)) : num(opts.days, 'days') ?? 7;
        if (opts.write !== undefined) {
          // The weekly timer's call: the page goes to dispatch.routing.reportFile in the vault (or the path given).
          const path = str(opts.write) ?? join(config.vaultRoot, settings().dispatch.routing.reportFile);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, routeReportMarkdown(await routeWeekly(days)));
          out(`wrote ${path}`);
          return 0;
        }
        if (opts.markdown === true) {
          out(routeReportMarkdown(await routeWeekly(days)));
          return 0;
        }
        const rows = await routeReport(days);
        if (json) out(JSON.stringify(rows, null, 2));
        else out(rows.length ? rows.map((r) => `${r.tier}: ${r.decisions} runs, ${r.escalated} escalated, ${r.merged} merged, cost ${r.cost_usd ?? 'unknown'} USD, per merged ${r.cost_per_merged_usd ?? 'unknown'} USD`).join('\n') : 'no routed runs in that window');
        return 0;
      }
      throw new OrgError('route decide|outcome|classify|report');
    }
    case 'plan': {
      if (!pos[0]) throw new OrgError('plan <org.json> [--prune] [--json]');
      const p = await planOrgFile(JSON.parse(readFileSync(pos[0], 'utf8')), { prune: opts.prune === true });
      out(json ? JSON.stringify(p, null, 2) : formatPlan(p));
      return 0;
    }
    case 'apply': {
      if (!pos[0]) throw new OrgError('apply <org.json> [--prune] [--sha <git sha>] [--by <name>] [--json]');
      const str = (k: string): string | undefined => (typeof opts[k] === 'string' ? (opts[k] as string) : undefined);
      const r = await applyOrg(JSON.parse(readFileSync(pos[0], 'utf8')), {
        prune: opts.prune === true, sha: str('sha'), by: str('by') ?? (config.env.ORG_AGENT?.trim() || undefined),
      });
      out(json ? JSON.stringify(r, null, 2) : formatApply(r));
      return 0;
    }
    case 'compile':
      // The org compiler lives in the engine (engine-core-v2 proposal, decision 3); `secondbrain org compile`
      // and `secondbrain org-compile` both land here. No database is touched.
      return compileMain(rest);
    case 'avatar': {
      const sub = pos[0];
      const names = pos.slice(1);
      if (sub === 'show') {
        const rows = await subjectsFromDb(names);
        if (json) return (out(JSON.stringify(rows, null, 2)), 0);
        for (const a of rows) out(`${a.name.padEnd(12)} ${a.avatar ?? '(no avatar)'}${a.avatar_prompt ? `\n             ${a.avatar_prompt.replace(/\s+/g, ' ').trim()}` : ''}`);
        return 0;
      }
      if (sub === 'generate') {
        if (!names.length && !opts['all']) throw new OrgError('avatar generate <name>... | --all');
        const subjects = opts['org']
          ? subjectsFromOrgFile(JSON.parse(readFileSync(String(opts['org']), 'utf8')), names)
          : await subjectsFromDb(names);
        const useDb = !opts['no-db'] && !opts['org'];
        let failed = 0;
        for (const a of subjects) {
          try {
            const r = await generateAvatar(a, { force: !!opts['force'], dryRun: !!opts['dry-run'], ...(typeof opts['dir'] === 'string' ? { dir: opts['dir'] } : {}) });
            if (r.skipped === 'exists') out(`${a.name}: kept ${r.path} (--force to redraw)`);
            else if (r.skipped === 'dry-run') out(`${a.name}: would write ${r.path}\n--- prompt ---\n${r.note ?? ''}\n---`);
            else {
              let recorded = '';
              if (useDb) recorded = (await setAvatar(a.name, r.path)) ? ', row updated' : ', no roster row';
              out(`${a.name}: wrote ${r.path} (${Math.round(r.bytes / 1024)} KB${recorded})  add to its org entry:  avatar: ${r.path}`);
            }
          } catch (err) {
            failed++;
            console.error(`${a.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return failed ? 1 : 0;
      }
      throw new OrgError('avatar show [<name>] | avatar generate <name>... | --all');
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
  await exitFlushed(code);
}
