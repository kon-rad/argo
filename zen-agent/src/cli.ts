#!/usr/bin/env node
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { Models } from '@earendil-works/pi-ai';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ZenAgent, type RunResult } from './agent.js';
import { loadConfig, THINKING_LEVELS, type Budget, type ThinkingLevel, type ZenConfig } from './config.js';
import { decide, findLocalRules, loadLocalRules } from './guard.js';
import { refreshMachines } from './machines.js';
import { availableProviders, buildModels } from './models.js';
import { listPersonas, loadPersona } from './persona.js';
import { Session } from './session.js';
import { startServer } from './serve.js';
import { discoverSkills } from './skills.js';
import { makeKanban } from './tools/kanban.js';
import { runWake, wakeContext } from './wake.js';

const USAGE = `zen-agent: a minimal agent harness

  zen-agent run [prompt] [--file f]      one task, final answer on stdout
  zen-agent chat                         interactive session
  zen-agent serve [--port 8791] [--host 127.0.0.1]
                                         the chat host: live sessions over HTTP for the second brain's chat page
                                         (bearer token from ZEN_SERVE_TOKEN; loopback only unless --host says otherwise)
  zen-agent wake <card-id>               work one kanban card (the card is the task; always a fresh session)
  zen-agent lane [--runtime zen-agent|--agent name] [--once] [--interval 30]
                                         claim ready cards from the engine's board and wake for each (the zen-agent lane)
  zen-agent models [--available]         providers and models
  zen-agent personas | skills | sessions what the vault offers
  zen-agent config                       the effective configuration
  zen-agent guard                        a PreToolUse hook: payload on stdin, exit 2 blocks

Options: --persona <name>  --model <provider/model>  --thinking <level>  --config <zen.json>
         --workdir <dir>  --task "<standing orders>"  --task-file <f>  --handoff-file <f>
         --tools fs,shell,...  --meta key=value (repeatable)  --meta-json '{...}'
         --max-turns N  --max-tokens N  --max-minutes N  --board <slug>  --json  --quiet
         --thread <message id>  the thread this run answers (a DM, handoff or mention wake): its messages become the
                                thread part of the prompt, nothing else of the board does
         --fetch a,b | none     context fetchers for this wake (tracker, github, recall); default: context.fetchers
         --resume <session>     run and chat only: continue a session. A wake never resumes
         lane: --runtime <r> | --agent <name>  --once  --interval <seconds>
         sessions: --json       one summary line per session (parts, fetchers, usage) for comparing runs
A dispatcher's flags: --tools picks this run's tool sets, --handoff-file is the previous run's conclusion
(the handoff part), --meta labels land in the trace's meta line under "dispatch".
Secrets come from the environment only (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...; see README).`;

export interface Flags {
  persona?: string;
  model?: string;
  config?: string;
  workdir?: string;
  task?: string;
  'task-file'?: string;
  'handoff-file'?: string;
  tools?: string;
  thinking?: string;
  meta?: string[];
  'meta-json'?: string;
  resume?: string;
  thread?: string;
  fetch?: string;
  file?: string;
  board?: string;
  agent?: string;
  runtime?: string;
  interval?: string;
  once?: boolean;
  port?: string;
  host?: string;
  'max-turns'?: string;
  'max-tokens'?: string;
  'max-minutes'?: string;
  json?: boolean;
  quiet?: boolean;
  available?: boolean;
  help?: boolean;
}

function parse(argv: string[]): { command: string; positionals: string[]; flags: Flags } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      persona: { type: 'string', short: 'p' },
      model: { type: 'string', short: 'm' },
      config: { type: 'string', short: 'c' },
      workdir: { type: 'string', short: 'C' },
      task: { type: 'string' },
      'task-file': { type: 'string' },
      'handoff-file': { type: 'string' },
      tools: { type: 'string' },
      thinking: { type: 'string' },
      meta: { type: 'string', multiple: true },
      'meta-json': { type: 'string' },
      resume: { type: 'string' },
      thread: { type: 'string' },
      fetch: { type: 'string' },
      file: { type: 'string', short: 'f' },
      board: { type: 'string' },
      agent: { type: 'string' },
      runtime: { type: 'string' },
      interval: { type: 'string' },
      once: { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      'max-turns': { type: 'string' },
      'max-tokens': { type: 'string' },
      'max-minutes': { type: 'string' },
      json: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      available: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command = 'help', ...rest] = positionals;
  return { command, positionals: rest, flags: values as Flags };
}

function budgetFlags(f: Flags): Partial<Budget> {
  const out: Partial<Budget> = {};
  if (f['max-turns']) out.turns = Number(f['max-turns']);
  if (f['max-tokens']) out.tokens = Number(f['max-tokens']);
  if (f['max-minutes']) out.minutes = Number(f['max-minutes']);
  return out;
}

/** The model catalogue with the connected computers' installed models registered, or undefined when there are none (the agent then builds its own). */
async function liveModels(cfg: ZenConfig): Promise<Models | undefined> {
  if (!Object.keys(cfg.machines).length) return undefined;
  const models = buildModels(cfg);
  await refreshMachines(models, cfg.machines, new Map());
  return models;
}

function config(f: Flags): ZenConfig {
  return loadConfig({ path: f.config, workdir: f.workdir, overrides: f.model ? { model: f.model } : {} });
}

/** `--meta key=value` pairs and `--meta-json` merged into one object: the dispatcher's labels for the trace. */
export function parseMeta(pairs: string[] = [], json?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (json) {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--meta-json must be a JSON object');
    Object.assign(out, parsed);
  }
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq <= 0) throw new Error(`--meta expects key=value, got "${p}"`);
    out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

export function parseThinking(level?: string): ThinkingLevel | undefined {
  if (level === undefined) return undefined;
  if (!(THINKING_LEVELS as readonly string[]).includes(level)) throw new Error(`--thinking must be one of ${THINKING_LEVELS.join(', ')}`);
  return level as ThinkingLevel;
}

export function parseTools(list?: string): string[] | undefined {
  if (list === undefined) return undefined;
  const names = list.split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new Error('--tools expects a comma list of tool sets');
  return names;
}

/** The per-run options every command shares: standing orders (inline or from a file), the handoff, tools, thinking, labels. */
export function runOptions(f: Flags): { task?: string; handoff?: string; toolSets?: string[]; thinking?: ThinkingLevel; model?: string; dispatch: Record<string, unknown> } {
  const fromFile = f['task-file'] ? readFileSync(f['task-file'], 'utf8').trim() : undefined;
  const task = [f.task, fromFile].filter((s): s is string => Boolean(s && s.trim())).join('\n\n') || undefined;
  return {
    task,
    handoff: f['handoff-file'] ? readFileSync(f['handoff-file'], 'utf8').trim() || undefined : undefined,
    toolSets: parseTools(f.tools),
    thinking: parseThinking(f.thinking),
    // --model beats the persona's own model, as the README says; config(f) only moved the default.
    model: f.model,
    dispatch: parseMeta(f.meta, f['meta-json']),
  };
}

function threadFlag(f: Flags): number | null {
  if (f.thread === undefined) return null;
  if (!/^\d+$/.test(f.thread)) throw new Error('--thread takes a message id (a number)');
  return Number(f.thread);
}

/** `--fetch a,b` names the fetchers; `--fetch none` turns them all off; no flag means the configured ones. */
function fetchFlag(f: Flags): string[] | null {
  if (f.fetch === undefined) return null;
  const names = f.fetch.split(',').map((s) => s.trim()).filter(Boolean);
  return names.length === 1 && names[0] === 'none' ? [] : names;
}

/** The persona of this run: the flag, else what the dispatcher sets (ORG_AGENT), else ZEN_PERSONA. */
function personaOf(f: Flags): string | null {
  return f.persona ?? process.env['ZEN_PERSONA'] ?? process.env['ORG_AGENT'] ?? null;
}

/** Streams the model's text to stdout and the tool calls to stderr, so a pipe gets only the answer. */
function printer(quiet: boolean): (e: AgentEvent) => void {
  const starts = new Map<string, number>();
  return (e) => {
    if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') process.stdout.write(e.assistantMessageEvent.delta);
    else if (e.type === 'message_end' && (e.message as { role: string }).role === 'assistant') {
      const m = e.message as { content: { type: string }[] };
      if (Array.isArray(m.content) && m.content.some((b) => b.type === 'text')) process.stdout.write('\n');
    }
    else if (!quiet && e.type === 'tool_execution_start') {
      starts.set(e.toolCallId, Date.now());
      process.stderr.write(`▸ ${e.toolName} ${JSON.stringify(e.args).slice(0, 160)}\n`);
    } else if (!quiet && e.type === 'tool_execution_end') {
      const ms = Date.now() - (starts.get(e.toolCallId) ?? Date.now());
      process.stderr.write(`${e.isError ? '✗' : '✓'} ${e.toolName} (${ms} ms)\n`);
    }
  };
}

function report(r: RunResult, flags: Flags): number {
  if (flags.json) process.stdout.write(JSON.stringify(r) + '\n');
  else if (!flags.quiet) {
    process.stderr.write(`— ${r.stopped}, ${r.turns} turns, ${r.usage.total} tokens ($${r.usage.cost.toFixed(4)}), session ${r.sessionPath}\n`);
    if (r.error) process.stderr.write(`error: ${r.error}\n`);
  }
  if (r.stopped === 'error') return 1;
  if (r.stopped === 'budget' || /^BLOCKED:/m.test(r.text)) return 3;
  return 0;
}

async function readPrompt(positionals: string[], flags: Flags): Promise<string> {
  if (flags.file) return readFileSync(flags.file, 'utf8');
  if (positionals.length) return positionals.join(' ');
  if (process.stdin.isTTY) throw new Error('give a prompt as an argument, with --file, or on stdin');
  return readFileSync(0, 'utf8');
}

async function main(argv: string[]): Promise<number> {
  const { command, positionals, flags } = parse(argv);
  if (flags.help || command === 'help') return (console.log(USAGE), 0);

  switch (command) {
    case 'run': {
      const prompt = (await readPrompt(positionals, flags)).trim();
      if (!prompt) throw new Error('empty prompt');
      const cfg = config(flags);
      const name = personaOf(flags);
      const persona = name ? loadPersona(cfg, name) : null;
      // A DM, handoff or mention wake: the thread it answers is the only board history in the prompt.
      const ctx = await wakeContext({ cfg, card: null, persona, thread: threadFlag(flags), fetchers: fetchFlag(flags) ?? [] });
      const zen = new ZenAgent({ config: cfg, persona, budget: budgetFlags(flags), ...runOptions(flags), parts: ctx.parts, fetchers: ctx.fetchers, resume: flags.resume, models: await liveModels(cfg), onEvent: flags.json ? undefined : printer(flags.quiet === true) });
      return report(await zen.run(prompt), flags);
    }
    case 'chat': {
      const chatCfg = config(flags);
      const zen = new ZenAgent({ config: chatCfg, persona: personaOf(flags), budget: { turns: 10_000, tokens: 50_000_000, minutes: 100_000, ...budgetFlags(flags) }, ...runOptions(flags), resume: flags.resume, models: await liveModels(chatCfg), onEvent: printer(flags.quiet === true) });
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      process.stderr.write(`zen-agent chat: ${zen.persona?.name ?? 'default'} on ${zen.model.provider}/${zen.model.id}; session ${zen.session.id}. /quit to leave.\n`);
      for (;;) {
        const line = (await rl.question('> ').catch(() => '/quit')).trim();
        if (line === '/quit' || line === '/exit') break;
        if (!line) continue;
        const r = await zen.run(line);
        if (r.error) process.stderr.write(`error: ${r.error}\n`);
      }
      rl.close();
      return 0;
    }
    case 'serve': {
      const token = process.env['ZEN_SERVE_TOKEN'] ?? '';
      if (!token) throw new Error('serve needs ZEN_SERVE_TOKEN in the environment (a long random string the proxy sends back)');
      const port = flags.port === undefined ? 8791 : Number(flags.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a port number');
      const { url, host } = await startServer({ config: config(flags), token, port, host: flags.host ?? '127.0.0.1' });
      process.stderr.write(`zen-agent serve: ${url} (chats in ${host.chatsDir}, ${host.list().length} known). Ctrl-C to stop.\n`);
      await new Promise<void>((resolve) => {
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
      });
      return 0;
    }
    case 'wake': {
      const [cardId] = positionals;
      if (!cardId) throw new Error('wake <card-id>');
      if (flags.resume !== undefined) throw new Error('wake never resumes a session: every wake is a fresh run (continuity is the memory file and org_remember). --resume is for run and chat.');
      const cfg = config(flags);
      const persona = personaOf(flags);
      const kb = makeKanban(cfg.kanban, process.env, fetch);
      if (!kb) throw new Error('wake needs a kanban backend in zen.json ("kanban": {"kind": "board", ...})');
      const r = await runWake({ cfg, kb, cardId, board: flags.board, persona, budget: budgetFlags(flags), ...runOptions(flags), thread: threadFlag(flags), fetchers: fetchFlag(flags), models: await liveModels(cfg), onEvent: flags.json ? undefined : printer(flags.quiet === true) });
      return report(r, flags);
    }
    case 'lane': {
      // The lane loop of docs/board-design.md section 7: claim, run the wake, heartbeat while it runs, report. Only the
      // engine's board can be claimed from; the card's own tools finish or block it, and a run that ends without doing so
      // releases the card so the next wake finds it ready.
      const cfg = config(flags);
      const persona = personaOf(flags);
      const kb = makeKanban(cfg.kanban, process.env, fetch);
      if (!kb?.claim) throw new Error('lane needs the engine\'s board in zen.json ("kanban": {"kind": "board", ...})');
      const agent = flags.agent ?? (flags.runtime ? undefined : persona ?? undefined);
      const runtime = flags.runtime ?? (agent ? undefined : 'zen-agent');
      const interval = Math.max(5, Number(flags.interval ?? 30)) * 1000;
      let worked = 0;
      for (;;) {
        const claimed = await kb.claim({ runtime, agent, board: flags.board });
        if (!claimed) {
          if (flags.once) return worked ? 0 : 3;
          await new Promise((r) => setTimeout(r, interval));
          continue;
        }
        const who = claimed.assignee ?? persona;
        const beat = setInterval(() => void kb.heartbeat?.(claimed.id, {}).catch(() => {}), 60_000);
        let r: RunResult;
        try {
          r = await runWake({ cfg, kb, cardId: claimed.id, board: flags.board, persona: who, budget: budgetFlags(flags), task: flags.task, fetchers: fetchFlag(flags), canComplete: true, models: await liveModels(cfg), onEvent: flags.json ? undefined : printer(flags.quiet === true) });
        } finally {
          clearInterval(beat);
        }
        worked++;
        const after = await kb.show(claimed.id, flags.board).catch(() => null);
        if (after?.task.status === 'running' && kb.release) {
          await kb.release(claimed.id, r.error ?? `run ended (${r.stopped}) without finishing the card`, { tokens: r.usage.input + r.usage.output, turns: r.turns }).catch(() => {});
        }
        if (flags.json) console.log(JSON.stringify({ card: claimed.id, stopped: r.stopped, turns: r.turns, usage: r.usage, error: r.error ?? null, status: after?.task.status ?? null }));
        else console.error(`card ${claimed.id}: ${after?.task.status ?? '?'} after ${r.turns} turn(s), ${r.stopped}${r.error ? `: ${r.error}` : ''}`);
        if (flags.once) return r.error ? 3 : 0;
      }
    }
    case 'models': {
      const cfg = config(flags);
      const models = (await liveModels(cfg)) ?? buildModels(cfg);
      const avail = new Set(await availableProviders(models));
      const rows = models
        .getModels()
        .filter((m) => !flags.available || avail.has(m.provider))
        .map((m) => ({ provider: m.provider, id: m.id, context: m.contextWindow, configured: avail.has(m.provider) }));
      if (flags.json) console.log(JSON.stringify(rows, null, 2));
      else for (const r of rows) console.log(`${r.configured ? '*' : ' '} ${r.provider}/${r.id}  (${r.context} ctx)`);
      if (!flags.json) console.error(`* = key found. ${avail.size} providers configured: ${[...avail].join(', ') || 'none'}`);
      return 0;
    }
    case 'personas': {
      const rows = listPersonas(config(flags));
      if (flags.json) console.log(JSON.stringify(rows, null, 2));
      else for (const p of rows) console.log(`${p.name.padEnd(14)} ${(p.team ?? '-').padEnd(12)} ${p.runtime.padEnd(12)} ${p.role}`);
      return 0;
    }
    case 'skills': {
      const rows = discoverSkills(config(flags).skills);
      if (flags.json) console.log(JSON.stringify(rows, null, 2));
      else for (const s of rows) console.log(`${s.name.padEnd(20)} ${s.description.slice(0, 100)}\n${''.padEnd(20)} ${s.dir}`);
      return 0;
    }
    case 'sessions': {
      const cfg = config(flags);
      for (const id of Session.list(cfg.sessionsDir)) {
        if (!flags.json) console.log(id);
        else {
          const s = Session.summary(cfg.sessionsDir, id);
          console.log(JSON.stringify({ ...s, parts: Object.fromEntries(s.parts.map((p) => [p.name, p.tokens])), fetchers: s.fetchers.filter((f) => f.on).map((f) => f.name) }));
        }
      }
      return 0;
    }
    case 'config': {
      console.log(JSON.stringify(config(flags), null, 2));
      return 0;
    }
    case 'guard': {
      const payload = JSON.parse(readFileSync(0, 'utf8') || '{}') as { cwd?: string; hook_event_name?: string };
      const cwd = payload.cwd ?? process.cwd();
      const reason = decide(payload, loadLocalRules(findLocalRules(cwd)));
      if (reason) {
        if (payload.hook_event_name === 'PreToolUse' || !payload.hook_event_name) {
          console.error(reason);
          return 2;
        }
        console.log(JSON.stringify({ decision: 'block', reason }));
        return 0;
      }
      if (payload.hook_event_name && payload.hook_event_name !== 'PreToolUse') console.log('{}');
      return 0;
    }
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

// Run only as the command (not when a test imports the parsers above).
function isMain(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`zen-agent: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
