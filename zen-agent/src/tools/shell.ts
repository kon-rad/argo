import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { spawn } from 'node:child_process';
import { clipOutput, text, tool, type ToolContext } from './index.js';

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export function runShell(command: string, opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<ShellResult> {
  return new Promise((done) => {
    const child = spawn('bash', ['-c', command], { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ stdout, stderr: stderr + err.message, code: null, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      done({ stdout, stderr, code, timedOut });
    });
  });
}

/** One shell tool. Output is capped head and tail; the model is told to cap it itself. */
export function shellTools(ctx: ToolContext): AgentTool<any>[] {
  const bash = tool({
    name: 'bash',
    label: 'Shell',
    description:
      `Run a bash command in the working directory (${ctx.cfg.workdir}). Output is cut to ${ctx.cfg.shell.maxOutput} characters, ` +
      'so cap it yourself (| tail -n 50, grep -m 20, > file then grep). Long jobs: write output to a file.',
    parameters: Type.Object({
      command: Type.String(),
      timeout_s: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: `Seconds before the command is killed (default ${ctx.cfg.shell.timeoutS})` })),
    }),
    executionMode: 'sequential',
    execute: async (a, signal) => {
      const r = await runShell(a.command, { cwd: ctx.cfg.workdir, env: ctx.env, timeoutMs: (a.timeout_s ?? ctx.cfg.shell.timeoutS) * 1000, signal });
      const parts = [r.stdout.trimEnd()];
      if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
      if (r.timedOut) parts.push('[killed: timeout]');
      else if (r.code !== 0) parts.push(`[exit ${r.code}]`);
      const out = clipOutput(parts.filter(Boolean).join('\n') || '(no output)', ctx.cfg.shell.maxOutput);
      return { ...text(out, { code: r.code, timedOut: r.timedOut }), isError: r.timedOut || (r.code !== 0 && r.code !== null) };
    },
  });
  return [bash];
}
