import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Static, TSchema } from 'typebox';
import type { Models } from '@earendil-works/pi-ai';
import type { Budget, ZenConfig } from '../config.js';
import type { Persona } from '../persona.js';
import type { Skill } from '../skills.js';
import { fsTools } from './fs.js';
import { kanbanTools } from './kanban.js';
import { knowledgeTools } from './knowledge.js';
import { orgTools } from './org.js';
import { shellTools } from './shell.js';
import { skillTools } from './skill.js';
import { subagentTools } from './subagent.js';

/** What every tool set gets to build itself. */
export interface ToolContext {
  cfg: ZenConfig;
  persona: Persona | null;
  models: Models;
  skills: Skill[];
  /** 0 for the top-level agent; sub-agents cannot spawn sub-agents. */
  depth: number;
  /** Runs a child agent and returns its final text (set by ZenAgent). */
  delegate?: (opts: { objective: string; persona?: string; budget?: Partial<Budget> }) => Promise<{ text: string; stopped: string; sessionId: string }>;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
}

export type ToolSet = (ctx: ToolContext) => AgentTool<any>[];

export const TOOL_SETS: Record<string, ToolSet> = {
  fs: fsTools,
  shell: shellTools,
  skills: skillTools,
  knowledge: knowledgeTools,
  kanban: kanbanTools,
  org: orgTools,
  subagent: subagentTools,
};

/** The tools a run gets: the configured sets, each deciding from the config whether it has anything to offer. */
export function buildTools(ctx: ToolContext, names: string[] = ctx.cfg.tools): AgentTool<any>[] {
  const out: AgentTool<any>[] = [];
  for (const name of names) {
    const set = TOOL_SETS[name];
    if (!set) throw new Error(`unknown tool set "${name}" (have: ${Object.keys(TOOL_SETS).join(', ')})`);
    out.push(...set(ctx));
  }
  return out;
}

/** A tool whose `execute` receives arguments typed by its TypeBox schema. */
export function tool<T extends TSchema>(def: {
  name: string;
  label: string;
  description: string;
  parameters: T;
  executionMode?: 'sequential' | 'parallel';
  execute: (args: Static<T>, signal?: AbortSignal) => Promise<AgentToolResult<any>>;
}): AgentTool<any> {
  const { execute, ...rest } = def;
  return { ...rest, execute: (_id, params, signal) => execute(params as Static<T>, signal) };
}

/** Text result helper: tools return content blocks; details carry what a log wants. */
export function text(s: string, details: unknown = {}) {
  return { content: [{ type: 'text' as const, text: s }], details };
}

/** Keeps a tool result inside the context budget: the head and the tail, with the middle cut. */
export function clipOutput(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n[… ${s.length - max} characters cut …]\n${s.slice(-half)}`;
}
