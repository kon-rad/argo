import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WRAPPER = resolve(import.meta.dirname, '..', '..', 'bin', 'statusline-usage.mjs');
const ECHO = ['node', '-e', 'process.stdin.on("data",d=>process.stdout.write("SL:"+JSON.parse(d).model.display_name))'];
const input = (limits?: object) => JSON.stringify({ session_id: 's1', model: { display_name: 'Opus' }, ...(limits ? { rate_limits: limits } : {}) });
const run = (log: string, stdin: string) =>
  execFileSync('node', [WRAPPER, '--', ...ECHO], { input: stdin, env: { ...process.env, PLAN_USAGE_LOG: log } }).toString();

describe('statusline-usage wrapper', () => {
  it('logs rate limits once per change and passes the status line through', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'sl-')), 'plan.ndjson');
    const limits = { five_hour: { used_percentage: 23.5, resets_at: 1791900000 } };
    expect(run(log, input(limits))).toBe('SL:Opus');
    run(log, input(limits));                                            // unchanged: no new line
    run(log, input({ five_hour: { used_percentage: 24, resets_at: 1791900000 } }));
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.rate_limits.five_hour.used_percentage)).toEqual([23.5, 24]);
    expect(lines[0].session_id).toBe('s1');
  });

  it('writes nothing without rate limits and never breaks the status line on bad input', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'sl-')), 'plan.ndjson');
    expect(run(log, input())).toBe('SL:Opus');
    expect(existsSync(log)).toBe(false);
    expect(() => execFileSync('node', [WRAPPER], { input: 'not json', env: { ...process.env, PLAN_USAGE_LOG: log } })).not.toThrow();
  });
});
