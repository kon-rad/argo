import { existsSync, readFileSync } from 'node:fs';
import type { Persona } from './persona.js';
import { personaHeader } from './persona.js';
import type { Skill } from './skills.js';
import { skillsIndex } from './skills.js';

/**
 * The system prompt is assembled from named parts, each with a token cap, and
 * the size of every part is recorded in the session. What enters the context
 * is the biggest cost lever in a headless run, so it is measured, never
 * guessed: a part that never changes the outcome can be capped or dropped by
 * policy with numbers behind the decision.
 */
export interface Part {
  name: string;
  text: string;
  /** Token cap; 0 means unlimited. */
  cap: number;
}

export interface PartStat {
  name: string;
  chars: number;
  tokens: number;
  truncated: boolean;
}

export interface Assembled {
  prompt: string;
  parts: PartStat[];
  tokens: number;
}

/** Four characters per token is the usual estimate for English and code; it is counted, not billed. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function clip(text: string, capTokens: number): { text: string; truncated: boolean } {
  if (!capTokens || estimateTokens(text) <= capTokens) return { text, truncated: false };
  const keep = capTokens * 4;
  const cut = text.lastIndexOf('\n', keep);
  return { text: `${text.slice(0, cut > keep / 2 ? cut : keep).trimEnd()}\n[… truncated at ${capTokens} tokens]`, truncated: true };
}

export function assemble(parts: Part[]): Assembled {
  const stats: PartStat[] = [];
  const blocks: string[] = [];
  for (const p of parts) {
    const text = p.text.trim();
    if (!text) continue;
    const c = clip(text, p.cap);
    stats.push({ name: p.name, chars: c.text.length, tokens: estimateTokens(c.text), truncated: c.truncated });
    blocks.push(p.name === 'identity' ? c.text : `<${p.name}>\n${c.text}\n</${p.name}>`);
  }
  const prompt = blocks.join('\n\n');
  return { prompt, parts: stats, tokens: estimateTokens(prompt) };
}

export interface PromptInputs {
  persona: Persona | null;
  rulesFiles: string[];
  skills: Skill[];
  caps: Record<string, number>;
  /** Working directory, model, budget: the facts of this run. */
  environment: Record<string, string>;
  /** Extra instructions for this run (a wake's standing orders), kept apart from the task itself. */
  task?: string;
  /** What the previous run concluded (its end line and last words), so a fresh run needs no resumed transcript. */
  handoff?: string;
}

export const DEFAULT_IDENTITY =
  'You are a careful agent working in a personal second brain: a vault of markdown notes, scripts and skills. ' +
  'Do the task you are given, verify it, and report what changed with paths and commands. Keep context small: cap command output, read big files in parts.';

export function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p;
  return null;
}

export function buildSystemPrompt(input: PromptInputs): Assembled {
  const cap = (name: string) => input.caps[name] ?? 0;
  const rulesPath = firstExisting(input.rulesFiles);
  const env = Object.entries(input.environment)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const skills = input.skills.length
    ? `Skills you can load with read_skill(name) when a task matches:\n${skillsIndex(input.skills)}`
    : '';
  return assemble([
    { name: 'identity', text: input.persona ? personaHeader(input.persona) : DEFAULT_IDENTITY, cap: 0 },
    { name: 'persona', text: input.persona?.definition ?? '', cap: cap('persona') },
    { name: 'rules', text: rulesPath ? readFileSync(rulesPath, 'utf8') : '', cap: cap('rules') },
    { name: 'playbook', text: input.persona?.playbook ?? '', cap: cap('playbook') },
    { name: 'skills', text: skills, cap: cap('skills') },
    { name: 'handoff', text: input.handoff ?? '', cap: cap('handoff') },
    { name: 'task', text: input.task ?? '', cap: cap('task') },
    { name: 'environment', text: env, cap: 0 },
  ]);
}
