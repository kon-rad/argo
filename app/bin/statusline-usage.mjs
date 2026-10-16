#!/usr/bin/env node
// Claude Code status-line wrapper. Claude Code passes rate_limits (five_hour, seven_day:
// used_percentage 0-100, resets_at epoch seconds) to the status line for Pro/Max accounts
// after the first API response (code.claude.com/docs/en/statusline). This appends a line to
// the plan-usage log when they change, then runs the real status line (argv after `--`)
// with the same input. It must never break or slow the status line: every error is swallowed.
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const LOG = process.env.PLAN_USAGE_LOG ?? join(homedir(), '.local', 'share', 'secondbrain', 'plan-usage.ndjson');

function lastLine(path) {
  const size = statSync(path).size;
  const len = Math.min(size, 4096);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  const lines = buf.toString('utf8').trim().split('\n');
  return lines[lines.length - 1] ?? '';
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const raw = Buffer.concat(chunks);

try {
  const data = JSON.parse(raw.toString('utf8'));
  const limits = data?.rate_limits;
  if (limits && (limits.five_hour || limits.seven_day)) {
    const key = JSON.stringify(limits);
    let prev = null;
    if (existsSync(LOG)) {
      try { prev = JSON.stringify(JSON.parse(lastLine(LOG)).rate_limits); } catch { prev = null; }
    }
    if (prev !== key) {
      mkdirSync(dirname(LOG), { recursive: true });
      appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), session_id: data.session_id ?? null, rate_limits: limits }) + '\n');
    }
  }
} catch {
  // Not JSON or not writable: the status line still renders below.
}

const sep = process.argv.indexOf('--');
const next = sep >= 0 ? process.argv.slice(sep + 1) : [];
if (next.length) {
  const r = spawnSync(next[0], next.slice(1), { input: raw, stdio: ['pipe', 'inherit', 'inherit'] });
  process.exit(r.status ?? 0);
}
