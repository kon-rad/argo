import { describe, expect, it } from 'vitest';
import { codexCommand, codexPreflight, parseCodexResult, subscriptionEnv } from '../src/addons/dispatch/codex.js';
import type { Runner, RunnerResult } from '../src/addons/dispatch/index.js';

const ok: RunnerResult = { code: 0, stderr: '', stdout: [
  JSON.stringify({ type: 'thread.started', thread_id: '01a1b593-4e59-79f3-b85f-00559646839a' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'READY' } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 3 } }),
].join('\n') };

describe('Codex subscription adapter', () => {
  it('strips API credentials and endpoint overrides while preserving login location', () => {
    expect(subscriptionEnv({ PATH: '/bin', CODEX_HOME: '/auth', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', OPENAI_BASE_URL: 'other' }))
      .toEqual({ PATH: '/bin', CODEX_HOME: '/auth' });
  });

  it('constructs an exact-model fresh run and explicit resume', () => {
    expect(codexCommand('gpt-6-sol', '/repo', 'work', null, true)).toEqual([
      'exec', '--ignore-user-config', '--json', '--model', 'gpt-6-sol', '--sandbox', 'workspace-write', '--cd', '/repo', 'work',
    ]);
    expect(codexCommand('gpt-6-sol', '/repo', 'continue', 'session-1', true)).toEqual([
      'exec', 'resume', 'session-1', '--ignore-user-config', '--json', '--model', 'gpt-6-sol', 'continue',
    ]);
  });

  it('requires ChatGPT login then probes the exact requested model without fallback', async () => {
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const runner: Runner = async (_cmd, args, env) => {
      calls.push({ args, env });
      return args[0] === 'login' ? { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' } : ok;
    };
    expect(await codexPreflight(runner, 'codex', 'gpt-6-sol', '/repo', { OPENAI_API_KEY: 'secret' })).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toContain('gpt-6-sol');
    expect(calls[1]!.args).toContain('--ephemeral');
    expect(calls[0]!.env.OPENAI_API_KEY).toBeUndefined();
    expect(calls[1]!.env.OPENAI_API_KEY).toBeUndefined();
  });

  it('blocks API-key login, missing binary and unsupported model', async () => {
    const api: Runner = async () => ({ code: 0, stdout: 'Logged in using API key', stderr: '' });
    expect(await codexPreflight(api, 'codex', 'gpt-6-sol', '/repo', {})).toMatch(/subscription login unavailable/);
    const missing: Runner = async () => ({ code: 1, stdout: '', stderr: 'ENOENT' });
    expect(await codexPreflight(missing, 'codex', 'gpt-6-sol', '/repo', {})).toMatch(/subscription login unavailable/);
    const unsupported: Runner = async (_cmd, args) => args[0] === 'login'
      ? { code: 0, stdout: 'Logged in using ChatGPT', stderr: '' }
      : { code: 1, stdout: '{"type":"turn.failed"}', stderr: 'unknown model' };
    expect(await codexPreflight(unsupported, 'codex', 'gpt-6-sol', '/repo', {})).toMatch(/model gpt-6-sol unavailable/);
  });

  it('distinguishes success, error, cancellation and timeout from JSONL plus process state', () => {
    expect(parseCodexResult(ok)).toMatchObject({ state: 'done', text: 'READY', inputTokens: 12, outputTokens: 3 });
    expect(parseCodexResult({ ...ok, code: 1 })).toMatchObject({ state: 'error' });
    expect(parseCodexResult({ ...ok, cancelled: true })).toMatchObject({ state: 'cancelled' });
    expect(parseCodexResult({ ...ok, timedOut: true })).toMatchObject({ state: 'timeout' });
    expect(parseCodexResult({ code: 0, stdout: '', stderr: '' })).toMatchObject({ state: 'error' });
  });
});
