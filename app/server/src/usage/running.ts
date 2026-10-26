import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { query } from '../db.js';

/**
 * The agents running right now on this host: the live processes (ps and /proc/<pid>/environ) joined with the
 * wakeups a dispatcher has claimed and not finished (org_wakeups), and the roster's configured runtime and model.
 * Read-only; nothing here starts, stops or restarts a run.
 */
const exec = promisify(execFile);

export interface Proc { pid: number; user: string; elapsedSec: number; args: string; env: Record<string, string> }

export type RunningKind = 'bot' | 'lane' | 'other';

export interface RunningRow {
  kind: RunningKind;
  /** The bot's name, the lane's name, or a short label for a session that belongs to neither. */
  name: string;
  /** What this process really is: claude-code, zen-agent, 'zen-agent (claude bridge)' (a `claude` stand-in), hermes. */
  runtime: string;
  /** The model on the command line, else the roster's. */
  model: string | null;
  pid: number | null;
  user: string | null;
  elapsedSec: number | null;
  startedAt: string | null;
  runId: string | null;
  reason: string | null;
  ref: string | null;
  /** `running`: a live process. `claimed`: a dispatcher holds the wakeup but no process carries its run id. */
  state: 'running' | 'claimed';
  /** Where the roster says this bot runs (null for a lane or an unknown session). */
  configured: { runtime: string; model: string | null } | null;
  detail: string | null;
}

/** `[[dd-]hh:]mm:ss` as printed by `ps -o etime`. */
export function parseEtime(s: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** One `ps -eo pid=,user=,etime=,args=` line. */
export function parsePsLine(line: string): Omit<Proc, 'env'> | null {
  const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
  if (!m) return null;
  return { pid: Number(m[1]), user: m[2]!, elapsedSec: parseEtime(m[3]!), args: m[4]! };
}

const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** Which agent runtime a command line is, or null when it is not an agent process (a shell, a sleep, a database). */
export function runtimeOf(args: string): string | null {
  // A stand-in for the `claude` CLI that forwards each call to zen-agent: it answers to `claude` but is not Claude Code.
  if (/claude-zen-bridge/.test(args)) return 'zen-agent (claude bridge)';
  const t = args.split(/\s+/);
  const first = base(t[0] ?? '');
  const second = base(t[1] ?? '');
  // `bash /home/agent/.local/bin/claude -p …` is a wrapper script: it is the process, its `sh -c` parent is not.
  const exe = ['bash', 'sh', 'node', 'python3', 'python'].includes(first) && !t[1]?.startsWith('-') ? second : first;
  if (exe === 'claude') return 'claude-code';
  if (exe === 'zen-agent' || /zen-agent\/dist\/src\/cli\.js/.test(args)) return 'zen-agent';
  if (exe === 'hermes') return 'hermes';
  return null;
}

/** `--model X` or `--model=X`. */
export function modelOf(args: string): string | null {
  const m = /--model[ =](\S+)/.exec(args);
  return m ? m[1]! : null;
}

function otherLabel(runtime: string, args: string): string {
  if (/\bremote-control\b/.test(args)) return 'Remote Control server';
  if (/\bserve\b/.test(args)) return `${runtime} serve`;
  const slash = /\s-p\s+(\/[\w-]+)/.exec(args);
  if (slash) return `claude -p ${slash[1]}`;
  if (runtime === 'claude-code' && !/\s-p\b/.test(args)) return 'interactive Claude Code';
  return runtime;
}

export interface Claim { runId: string; agent: string; reason: string | null; ref: string | null; claimedAt: Date }
export interface RosterEntry { runtime: string; model: string | null }

/**
 * Pure join. A process with ORG_AGENT is that bot's run; one with only CC_LANE is a lane worker; the rest are
 * agent sessions that belong to no roster entry (cron runs, Remote Control, an interactive session).
 * A claimed wakeup nobody's process carries is listed as `claimed` so a stuck claim is visible.
 */
export function buildRunning(procs: Proc[], claims: Claim[], roster: Map<string, RosterEntry>, now = new Date()): RunningRow[] {
  const byRun = new Map(claims.map((c) => [c.runId, c]));
  const seen = new Set<string>();
  const rows: RunningRow[] = [];
  for (const p of procs) {
    const runtime = runtimeOf(p.args);
    if (!runtime) continue;
    const agent = p.env.ORG_AGENT ?? null;
    const runId = p.env.ORG_RUN ?? null;
    const claim = (runId ? byRun.get(runId) : undefined) ?? claims.find((c) => c.agent === agent && !seen.has(c.runId));
    if (claim) seen.add(claim.runId);
    const started = new Date(now.getTime() - p.elapsedSec * 1000).toISOString();
    const model = modelOf(p.args);
    if (agent) {
      const cfg = roster.get(agent) ?? null;
      rows.push({ kind: 'bot', name: agent, runtime, model: model ?? cfg?.model ?? null, pid: p.pid, user: p.user, elapsedSec: p.elapsedSec,
        startedAt: started, runId, reason: claim?.reason ?? null, ref: claim?.ref ?? null, state: 'running', configured: cfg, detail: null });
    } else if (p.env.CC_LANE) {
      rows.push({ kind: 'lane', name: p.env.CC_LANE, runtime, model, pid: p.pid, user: p.user, elapsedSec: p.elapsedSec, startedAt: started,
        runId, reason: 'task', ref: p.env.CC_TASK ?? null, state: 'running', configured: null, detail: null });
    } else {
      rows.push({ kind: 'other', name: otherLabel(runtime, p.args), runtime, model, pid: p.pid, user: p.user, elapsedSec: p.elapsedSec,
        startedAt: started, runId: null, reason: null, ref: null, state: 'running', configured: null, detail: null });
    }
  }
  for (const c of claims) {
    if (seen.has(c.runId)) continue;
    const cfg = roster.get(c.agent) ?? null;
    rows.push({ kind: 'bot', name: c.agent, runtime: cfg?.runtime ?? 'unknown', model: cfg?.model ?? null, pid: null, user: null,
      elapsedSec: Math.max(0, Math.round((now.getTime() - c.claimedAt.getTime()) / 1000)), startedAt: c.claimedAt.toISOString(),
      runId: c.runId, reason: c.reason, ref: c.ref, state: 'claimed', configured: cfg,
      detail: 'A dispatcher holds this wakeup but no process carries its run id (starting up, or a dead run whose claim is stale).' });
  }
  const order: Record<RunningKind, number> = { bot: 0, lane: 1, other: 2 };
  return rows.sort((a, b) => order[a.kind] - order[b.kind] || (b.elapsedSec ?? 0) - (a.elapsedSec ?? 0));
}

const WANTED_ENV = ['ORG_AGENT', 'ORG_RUN', 'CC_LANE', 'CC_TASK', 'HERMES_PROFILE'];

/** `ps` for the table, /proc/<pid>/environ for the labels the dispatcher sets. The environ read fails for other users' processes and off Linux: those rows just carry no labels. */
export async function listProcesses(): Promise<Proc[]> {
  const { stdout } = await exec('ps', ['-eo', 'pid=,user=,etime=,args='], { maxBuffer: 8 * 1024 * 1024 });
  const procs: Proc[] = [];
  for (const line of stdout.split('\n')) {
    const p = parsePsLine(line);
    if (!p || !runtimeOf(p.args)) continue;
    const env: Record<string, string> = {};
    try {
      const raw = await readFile(`/proc/${p.pid}/environ`, 'utf8');
      for (const kv of raw.split('\0')) {
        const i = kv.indexOf('=');
        if (i > 0 && WANTED_ENV.includes(kv.slice(0, i))) env[kv.slice(0, i)] = kv.slice(i + 1);
      }
    } catch {
      // not readable: no labels
    }
    procs.push({ ...p, env });
  }
  return procs;
}

export async function loadClaims(): Promise<Claim[]> {
  const { rows } = await query<{ claimed_by: string; agent_name: string; reason: string | null; ref: string | null; claimed_at: Date }>(
    `SELECT claimed_by, agent_name, reason, ref, claimed_at FROM org_wakeups
      WHERE claimed_by IS NOT NULL AND done_at IS NULL AND claimed_at IS NOT NULL ORDER BY claimed_at`);
  return rows.map((r) => ({ runId: r.claimed_by, agent: r.agent_name, reason: r.reason, ref: r.ref, claimedAt: r.claimed_at }));
}

export async function loadRoster(): Promise<Map<string, RosterEntry>> {
  const { rows } = await query<{ name: string; runtime: string; model: string | null }>(
    `SELECT name, runtime, model FROM org_agents WHERE retired_at IS NULL`);
  return new Map(rows.map((r) => [r.name, { runtime: r.runtime, model: r.model }]));
}

export async function running(): Promise<{ host: string; at: string; rows: RunningRow[]; configured: Record<string, number> }> {
  const [procs, claims, roster] = await Promise.all([listProcesses(), loadClaims(), loadRoster()]);
  const configured: Record<string, number> = {};
  for (const r of roster.values()) {
    if (r.runtime !== 'human') configured[r.runtime] = (configured[r.runtime] ?? 0) + 1;
  }
  return { host: hostname(), at: new Date().toISOString(), rows: buildRunning(procs, claims, roster), configured };
}
