import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model, Models } from '@earendil-works/pi-ai';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compact } from './compaction.js';
import type { Budget, ThinkingLevel, ZenConfig } from './config.js';
import { buildSystemPrompt, type Assembled, type Part, type PartStat } from './context.js';
import type { FetcherStat } from './fetchers.js';
import { decide, findLocalRules, loadLocalRules, logBlock, toolPayload, type LocalRules } from './guard.js';
import { runHooks, writeClaudeTranscript } from './hooks.js';
import { buildModels, pickModel } from './models.js';
import { loadPersona, type Persona } from './persona.js';
import { newSessionId, Session, TRACE_VERSION, ZERO_USAGE, type SessionLine, type UsageTotals } from './session.js';
import { discoverSkills, type Skill } from './skills.js';
import { buildTools, type ToolContext } from './tools/index.js';

/**
 * One run of one agent: a persona, a model, a tool loadout, a budget and a
 * session file. Everything the harness adds to the pi agent core is a hook on
 * its loop: the guard and external hooks in `beforeToolCall`, the budget in
 * `finishTurn`, compaction in `prepareRequest`, the trace in `subscribe`.
 */
export type Stopped = 'done' | 'budget' | 'error' | 'aborted';

export interface RunResult {
  text: string;
  stopped: Stopped;
  turns: number;
  usage: UsageTotals;
  /** `provider/id`, so a dispatcher's --json gets it without reading the trace. */
  model: string;
  /** The size of every system-prompt part, as the trace's meta line has it. */
  parts: PartStat[];
  sessionId: string;
  sessionPath: string;
  error?: string;
}

export interface ZenAgentOptions {
  config: ZenConfig;
  /** A roster name; null runs the default identity. */
  persona?: string | Persona | null;
  /** Overrides the config's and the persona's model. */
  model?: string;
  budget?: Partial<Budget>;
  /** Extra standing orders for this run, a part of the system prompt with its own cap. */
  task?: string;
  /** The previous run's conclusion, the `handoff` part (replaces resuming a transcript). */
  handoff?: string;
  /** Tool set names for this run, instead of the config's. */
  toolSets?: string[];
  /** Thinking level for this run, instead of the config's. */
  thinking?: ThinkingLevel;
  /** A dispatcher's labels (run id, wake reasons, card, tier, ...), written into the trace's meta line as `dispatch`. */
  dispatch?: Record<string, unknown>;
  /** Fetched prompt parts (a thread, the tracker row, PR status, recall hits), built by `wakeContext` before the run. */
  parts?: Part[];
  /** What each fetcher did, for the trace; the parts' sizes land in `parts` like every other part. */
  fetchers?: FetcherStat[];
  /**
   * Continue an earlier session (its messages are replayed). Explicit only: `run` and `chat` take it, a wake never does.
   * Alone, the run appends to that session's trace; with `sessionId` too, the messages are replayed into a new trace
   * (a fork: the chat host's "continue as a new session"), and the meta line's `resumed` names where they came from.
   */
  resume?: string;
  sessionId?: string;
  /** Streaming events for a UI; the session file gets everything regardless. */
  onEvent?: (event: AgentEvent) => void;
  /** Every line as it is written to the trace (meta, message, tool, blocked, compaction, end): the chat host's event log. */
  onTrace?: (line: SessionLine) => void;
  /** Shared catalogue (tests pass a faux provider). */
  models?: Models;
  tools?: AgentTool<any>[];
  depth?: number;
  parentSession?: string | null;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Tests: replaces the model call that writes a compaction summary. */
  summarize?: (text: string) => Promise<string>;
}

export function sumUsage(messages: unknown[]): UsageTotals {
  const t = { ...ZERO_USAGE };
  for (const m of messages) {
    const a = m as AssistantMessage;
    if (a.role !== 'assistant' || !a.usage) continue;
    t.input += a.usage.input;
    t.output += a.usage.output;
    t.cacheRead += a.usage.cacheRead;
    t.cacheWrite += a.usage.cacheWrite;
    t.total += a.usage.input + a.usage.output + a.usage.cacheRead + a.usage.cacheWrite;
    t.cost += a.usage.cost.total;
  }
  return t;
}

export function lastText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AssistantMessage;
    if (m.role !== 'assistant') continue;
    const text = m.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
}

export class ZenAgent {
  readonly config: ZenConfig;
  readonly persona: Persona | null;
  readonly models: Models;
  readonly model: Model<any>;
  readonly skills: Skill[];
  readonly session: Session;
  readonly budget: Budget;
  readonly prompt: Assembled;
  readonly agent: Agent;
  readonly tools: AgentTool<any>[];
  private readonly rules: LocalRules;
  private readonly env: NodeJS.ProcessEnv;
  private readonly depth: number;
  private readonly opts: ZenAgentOptions;
  private turns = 0;
  private startedAt = 0;
  private stopped: Stopped = 'done';
  private nudged = false;

  constructor(opts: ZenAgentOptions) {
    this.opts = opts;
    const cfg = opts.config;
    this.config = cfg;
    this.env = opts.env ?? process.env;
    this.depth = opts.depth ?? 0;
    this.persona = typeof opts.persona === 'string' ? loadPersona(cfg, opts.persona) : (opts.persona ?? null);
    this.models = opts.models ?? buildModels(cfg);
    this.model = pickModel(this.models, opts.model ?? this.persona?.model ?? cfg.model);
    this.budget = { ...cfg.budget, ...stripUndefined(opts.budget ?? {}) };
    this.skills = discoverSkills(cfg.skills);
    this.rules = loadLocalRules(findLocalRules(cfg.workdir, cfg.guard.local, this.env));

    const id = opts.sessionId ?? opts.resume ?? newSessionId(this.persona?.name ?? null);
    this.session = new Session(cfg.sessionsDir, id);

    this.prompt = buildSystemPrompt({
      persona: this.persona,
      rulesFiles: cfg.rules,
      skills: this.skills,
      caps: cfg.context.parts,
      task: opts.task,
      handoff: opts.handoff,
      extra: opts.parts ?? [],
      environment: {
        'working directory': cfg.workdir,
        vault: cfg.vault,
        date: new Date().toISOString().slice(0, 10),
        model: `${this.model.provider}/${this.model.id}`,
        budget: `${this.budget.turns} turns, ${this.budget.tokens} tokens, ${this.budget.minutes} minutes; when you cannot finish, say BLOCKED: <reason> and stop`,
      },
    });

    const toolCtx: ToolContext = {
      cfg,
      persona: this.persona,
      models: this.models,
      skills: this.skills,
      depth: this.depth,
      env: this.env,
      fetch: opts.fetch ?? fetch,
      delegate: (d) => this.delegate(d),
    };
    this.tools = opts.tools ?? buildTools(toolCtx, opts.toolSets ?? cfg.tools);

    const resumed = opts.resume ? Session.load(cfg.sessionsDir, opts.resume).messages : [];
    this.agent = new Agent({
      initialState: {
        systemPrompt: this.prompt.prompt,
        model: this.model,
        thinkingLevel: opts.thinking ?? cfg.thinking,
        tools: this.tools,
        messages: resumed as AgentMessage[],
      },
      streamFn: this.models.streamSimple.bind(this.models),
      sessionId: id,
      identity: { attribution: { name: 'zen-agent', url: 'https://github.com/kon-rad/secondbrain' } },
      toolExecution: 'sequential',
      beforeToolCall: async ({ toolCall, args }) => {
        const payload = toolPayload(toolCall.name, args, cfg.workdir);
        if (!payload) return undefined;
        let reason = decide(payload, this.rules);
        if (!reason && cfg.guard.hooks.preToolUse.length) {
          const hook = await runHooks(cfg.guard.hooks.preToolUse, { hook_event_name: 'PreToolUse', session_id: id, ...payload }, cfg.workdir);
          if (hook.block) reason = hook.reason ?? 'blocked by hook';
        }
        if (!reason) return undefined;
        logBlock(cfg.guard.log, 'zen-agent', payload.tool_name, reason);
        this.trace({ type: 'blocked', at: now(), name: toolCall.name, reason });
        return { block: true, reason };
      },
      prepareRequest: async ({ context }, signal) => {
        const cap = Math.floor(this.model.contextWindow * cfg.context.cap);
        const r = await compact(context.messages, {
          models: this.models,
          model: this.model,
          capTokens: cap,
          keepTurns: cfg.context.keepTurns,
          signal,
          summarize: opts.summarize,
        });
        if (!r.compacted) return undefined;
        this.trace({ type: 'compaction', at: now(), before: r.before, after: r.after, dropped: r.dropped });
        this.agent.state.messages = r.messages as AgentMessage[];
        return { context: { ...context, messages: r.messages as AgentMessage[] } };
      },
      finishTurn: async ({ message }) => {
        this.turns++;
        if (message.stopReason === 'error' || message.stopReason === 'aborted') return undefined;
        const usage = sumUsage(this.agent.state.messages);
        const minutes = (Date.now() - this.startedAt) / 60_000;
        if (this.turns >= this.budget.turns || usage.total >= this.budget.tokens || minutes >= this.budget.minutes) {
          this.stopped = 'budget';
          return { action: 'end' };
        }
        return undefined;
      },
    });

    this.agent.subscribe((event) => {
      if (event.type === 'message_end') this.trace({ type: 'message', at: now(), message: event.message });
      else if (event.type === 'tool_execution_end') {
        this.trace({ type: 'tool', at: now(), toolCallId: event.toolCallId, name: event.toolName, args: argsOf(this.agent.state.messages, event.toolCallId), isError: event.isError, durationMs: event.durationMs ?? null });
      }
      opts.onEvent?.(event);
    });

    this.trace({
      type: 'meta',
      version: TRACE_VERSION,
      id,
      at: now(),
      persona: this.persona?.name ?? null,
      model: `${this.model.provider}/${this.model.id}`,
      parts: this.prompt.parts,
      fetchers: opts.fetchers ?? [],
      parent: opts.parentSession ?? null,
      budget: this.budget,
      tools: this.tools.map((t) => t.name),
      skills: this.skills.map((s) => s.name),
      resumed: opts.resume ?? null,
      workdir: cfg.workdir,
      dispatch: opts.dispatch ?? {},
    });
  }

  /** One prompt, run to completion (or budget), with the stop hooks' one nudge. */
  async run(prompt: string): Promise<RunResult> {
    this.startedAt = this.startedAt || Date.now();
    this.stopped = 'done';
    await this.agent.prompt(prompt);
    await this.afterRun();
    if (this.stopped === 'done' && !this.nudged && this.config.guard.hooks.stop.length) {
      const nudge = await this.stopHooks(false);
      if (nudge) {
        this.nudged = true;
        this.trace({ type: 'blocked', at: now(), name: 'stop', reason: nudge });
        await this.agent.prompt(nudge);
        await this.afterRun();
        await this.stopHooks(true); // The second answer always passes; the hook is told so.
      }
    }
    return this.result();
  }

  /** Send a message while the agent is running tools; it is read after the current turn. */
  steer(text: string): void {
    this.agent.steer({ role: 'user', content: text, timestamp: Date.now() });
  }

  abort(): void {
    this.stopped = 'aborted';
    this.agent.abort();
  }

  result(): RunResult {
    const messages = this.agent.state.messages;
    const usage = sumUsage(messages);
    const err = this.agent.state.errorMessage;
    const stopped: Stopped = this.stopped !== 'done' ? this.stopped : err ? 'error' : 'done';
    const r: RunResult = {
      text: lastText(messages), stopped, turns: this.turns, usage, model: `${this.model.provider}/${this.model.id}`, parts: this.prompt.parts,
      sessionId: this.session.id, sessionPath: this.session.path,
    };
    if (err) r.error = err;
    return r;
  }

  /** The trace line goes to the session file and to whoever follows the run live. */
  private trace(line: SessionLine): void {
    this.session.write(line);
    this.opts.onTrace?.(line);
  }

  private async afterRun(): Promise<void> {
    const r = this.result();
    this.trace({ type: 'end', at: now(), stopped: r.stopped, turns: r.turns, usage: r.usage, ...(r.error ? { error: r.error } : {}) });
  }

  private async stopHooks(active: boolean): Promise<string | null> {
    const dir = mkdtempSync(join(tmpdir(), 'zen-stop-'));
    const transcript = join(dir, 'transcript.jsonl');
    try {
      writeClaudeTranscript(transcript, this.agent.state.messages);
      const r = await runHooks(
        this.config.guard.hooks.stop,
        { hook_event_name: 'Stop', session_id: this.session.id, transcript_path: transcript, stop_hook_active: active, cwd: this.config.workdir },
        this.config.workdir,
      );
      return r.block ? (r.reason ?? 'a stop hook asked for one more step') : null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async delegate(d: { objective: string; persona?: string; budget?: Partial<Budget> }): Promise<{ text: string; stopped: string; sessionId: string }> {
    const child = new ZenAgent({
      ...this.opts,
      persona: d.persona ?? this.persona,
      budget: { ...this.budget, turns: Math.min(this.budget.turns, 15), ...stripUndefined(d.budget ?? {}) },
      task: undefined,
      handoff: undefined,
      dispatch: undefined,
      parts: undefined,
      fetchers: undefined,
      resume: undefined,
      sessionId: undefined,
      tools: undefined,
      onEvent: undefined,
      onTrace: undefined,
      depth: this.depth + 1,
      parentSession: this.session.id,
      models: this.models,
    });
    const r = await child.run(d.objective);
    return { text: r.text, stopped: r.stopped, sessionId: r.sessionId };
  }
}

function now(): string {
  return new Date().toISOString();
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function argsOf(messages: unknown[], toolCallId: string): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AssistantMessage;
    if (m.role !== 'assistant') continue;
    const call = m.content.find((b) => b.type === 'toolCall' && (b as { id: string }).id === toolCallId) as { arguments?: unknown } | undefined;
    if (call) return call.arguments;
  }
  return undefined;
}
