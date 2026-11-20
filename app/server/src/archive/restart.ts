import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { restartPrompt, type PortableSession } from './portable.js';

export type RestartHarness = 'claude-code' | 'codex' | 'hermes' | 'zen-agent';
export interface RestartOptions {
  harness: RestartHarness;
  provider: string;
  model: string;
  persona: string | null;
  request: string;
  vaultRoot: string;
}
export interface LaunchSpec { command: string; args: string[]; input: string }

/** Read a named persona from the current vault, never from the archived run's machine. */
export function personaInstruction(vaultRoot: string, name: string | null): string {
  if (!name) return '';
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('invalid persona name');
  const path = join(vaultRoot, '.agents', 'org', 'config', 'agents', `${name}.yaml`);
  if (!existsSync(path)) throw new Error(`persona ${name} is not installed on this machine`);
  const row = yaml.safeLoad(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const fields = ['role', 'expertise', 'perspective', 'personality', 'goal'];
  return [`You are ${name}.`, ...fields.flatMap((key) => typeof row[key] === 'string' ? [`${key}: ${row[key]}`] : [])].join('\n');
}

/** Exact argv and stdin, with no shell expansion or transcript on the process list. */
export function launchSpec(session: PortableSession, opts: RestartOptions): LaunchSpec {
  if (!opts.request.trim()) throw new Error('a new request is required to restart a session');
  if (!opts.model.trim() || !opts.provider.trim()) throw new Error('provider and model are required');
  const persona = personaInstruction(opts.vaultRoot, opts.persona);
  const prompt = [persona, restartPrompt(session, opts.request)].filter(Boolean).join('\n\n');
  switch (opts.harness) {
    case 'claude-code':
      if (opts.provider !== 'anthropic') throw new Error('Claude Code only supports the Anthropic provider; choose zen-agent or Hermes for this provider');
      return { command: 'claude', args: ['--print', '--model', opts.model], input: prompt };
    case 'codex':
      return { command: 'codex', args: ['exec', '--model', opts.model, ...(opts.provider === 'openai' ? [] : ['--config', `model_provider=${opts.provider}`]), '-'], input: prompt };
    case 'hermes':
      return { command: 'hermes', args: ['chat', '--oneshot', '--query-file', '-', '--provider', opts.provider, '--model', opts.model], input: prompt };
    case 'zen-agent':
      return { command: 'zen-agent', args: ['run', '--model', `${opts.provider}/${opts.model}`], input: prompt };
    default:
      throw new Error('unsupported harness');
  }
}
