#!/usr/bin/env node
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ZenAgent, type RunResult } from './agent.js';
import { loadConfig, type Budget, type ZenConfig } from './config.js';
import { decide, findLocalRules, loadLocalRules } from './guard.js';
import { availableProviders, buildModels } from './models.js';
import { listPersonas, loadPersona } from './persona.js';
import { Session } from './session.js';
import { discoverSkills } from './skills.js';
import { makeKanban } from './tools/kanban.js';
import { runWake, wakeContext } from './wake.js';

const USAGE = `zen-agent: a minimal agent harness

  zen-agent run [prompt] [--file f]      one task, final answer on stdout
  zen-agent chat                         interactive session
  zen-agent wake <card-id>               work one kanban card (the card is the task; always a fresh session)
  zen-agent lane [--runtime zen-agent|--agent name] [--once] [--interval 30]
                                         claim ready cards from the engine's board and wake for each (the zen-agent lane)
  zen-agent models [--available]         providers and models
  zen-agent personas | skills | sessions what the vault offers
  zen-agent config                       the effective configuration
  zen-agent guard                        a PreToolUse hook: payload on stdin, exit 2 blocks

Options: --persona <name>  --model <provider/model>  --config <zen.json>  --workdir <dir>
         --task "<standing orders>"  --max-turns N  --max-tokens N  --max-minutes N
         --board <slug>  --json  --quiet
         --thread <message id>  the thread this run answers (a DM, handoff or mention wake): its messages become the
                                thread part of the prompt, nothing else of the board does
         --fetch a,b | none     context fetchers for this wake (tracker, github, recall); default: context.fetchers
         --resume <session>     run and chat only: continue a session. A wake never resumes
         lane: --runtime <r> | --agent <name>  --once  --interval <seconds>
         sessions: --json       one summary line per session (parts, fetchers, usage) for comparing runs
Secrets come from the environment only (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...; see README).`;

interface Flags {
  persona?: string;
  model?: string;
  config?: string;
  workdir?: string;
  task?: string;
  resume?: string;
  thread?: string;
  fetch?: string;
  file?: string;
  board?: string;
  agent?: string;
  runtime?: string;
  interval?: string;
  once?: boolean;
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
      resume: { type: 'string' },
      thread: { type: 'string' },
      fetch: { type: 'string' },
      file: { type: 'string', short: 'f' },
      board: { type: 'string' },
      agent: { type: 'string' },
      runtime: { type: 'string' },
      interval: { type: 'string' },
      once: { type: 'boolean' },
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

function config(f: Flags): ZenConfig {
  return loadConfig({ path: f.config, workdir: f.workdir, overrides: f.model ? { model: f.model } : {} });
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
      const zen = new ZenAgent({ config: cfg, persona, budget: budgetFlags(flags), task: flags.task, parts: ctx.parts, fetchers: ctx.fetchers, resume: flags.resume, onEvent: flags.json ? undefined : printer(flags.quiet === true) });
      return report(await zen.run(prompt), flags);
    }
    case 'chat': {
      const zen = new ZenAgent({ config: config(flags), persona: personaOf(flags), budget: { turns: 10_000, tokens: 50_000_000, minutes: 100_000, ...budgetFlags(flags) }, task: flags.task, resume: flags.resume, onEvent: printer(flags.quiet === true) });
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
    case 'wake': {
      const [cardId] = positionals;
      if (!cardId) throw new Error('wake <card-id>');
      if (flags.resume !== undefined) throw new Error('wake never resumes a session: every wake is a fresh run (continuity is the memory file and org_remember). --resume is for run and chat.');
      const cfg = config(flags);
      const persona = personaOf(flags);
      const kb = makeKanban(cfg.kanban, process.env, fetch, persona ?? 'zen-agent');
      if (!kb) throw new Error('wake needs a kanban backend in zen.json ("kanban": {"kind": "board" | "cli" | "hub", ...})');
      const r = await runWake({ cfg, kb, cardId, board: flags.board, persona, budget: budgetFlags(flags), task: flags.task, thread: threadFlag(flags), fetchers: fetchFlag(flags), onEvent: flags.json ? undefined : printer(flags.quiet === true) });
      return report(r, flags);
    }
    case 'lane': {
      // The lane loop of docs/board-design.md section 7: claim, run the wake, heartbeat while it runs, report. Only the
      // engine's board can be claimed from; the card's own tools finish or block it, and a run that ends without doing so
      // releases the card so the next wake finds it ready.
      const cfg = config(flags);
      const persona = personaOf(flags);
      const kb = makeKanban(cfg.kanban, process.env, fetch, persona ?? 'zen-agent');
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
          r = await runWake({ cfg, kb, cardId: claimed.id, board: flags.board, persona: who, budget: budgetFlags(flags), task: flags.task, fetchers: fetchFlag(flags), canComplete: true, onEvent: flags.json ? undefined : printer(flags.quiet === true) });
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
      const models = buildModels(config(flags));
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

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`zen-agent: ${(err as Error).message}`);
    process.exit(1);
  },
);
