import { hostname } from 'node:os';
import { query } from '../db.js';
import { listProcesses, loadClaims, loadRoster, buildRunning, type RunningRow } from './running.js';

/**
 * The live agents page: one list of everything working right now, on every machine, grouped by machine.
 * Two sources:
 *  - processes on the server this app runs on (ps + the dispatcher's claims, see running.ts), which can be stopped;
 *  - sessions another machine's ledger synced with activity in the last few minutes, which can only be read.
 */
export const ACTIVE_WINDOW_SEC = 180;

export interface LiveAgent {
  /** Stable across polls: `proc:<pid>` or `session:<host>:<external id>`. */
  id: string;
  machine: string;
  /** claude-code, hermes, zen-agent. */
  harness: string;
  name: string;
  model: string | null;
  /** What it works on. `cardId` links to the kanban card; `label` is the card title or the session title. */
  task: { cardId: string | null; label: string | null; reason: string | null } | null;
  source: 'process' | 'session';
  turns: number | null;
  tokens: { input: number; output: number } | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  elapsedSec: number | null;
  /** The session the log viewer opens, when we know it. */
  log: { host: string; externalId: string; source: string } | null;
  /** Set only for a process on this server; `pid` is what POST /usage/live/stop signals. */
  pid: number | null;
  runId: string | null;
  stoppable: boolean;
}

export interface LiveMachine { slug: string; display: string; kind: string | null; agents: LiveAgent[] }
export interface LiveNow { at: string; serverMachine: string; total: number; machines: LiveMachine[] }

export interface CardRunInfo { cardId: string; title: string; turns: number | null; tokens: number | null }
export interface SessionInfo {
  host: string; source: string; externalId: string; title: string | null; model: string | null; startedAt: Date | null;
  endedAt: Date | null; updatedAt: Date; messages: number; input: number | null; output: number | null; project: string | null;
}
export interface HostInfo { slug: string; display: string; kind: string | null }

const harnessOf = (source: string): string => source.split(':')[0]!;

/** Pure join: process rows, card info and recent sessions in, machines out. A machine nobody listed still gets a group. */
export function buildLive(
  procs: RunningRow[], cards: Map<string, CardRunInfo>, sessions: SessionInfo[], hosts: HostInfo[], serverMachine: string, now = new Date(),
): LiveNow {
  const agents: LiveAgent[] = [];
  const procHarness = new Set<string>();
  for (const r of procs) {
    procHarness.add(r.runtime.split(' ')[0]!);
    const card = r.ref ? cards.get(r.ref) ?? null : null;
    agents.push({
      id: r.pid !== null ? `proc:${r.pid}` : `claim:${r.runId ?? r.name}`,
      machine: serverMachine, harness: r.runtime, name: r.name, model: r.model,
      task: card || r.ref ? { cardId: card?.cardId ?? (r.ref?.startsWith('t_') ? r.ref : null), label: card?.title ?? null, reason: r.reason } : r.reason ? { cardId: null, label: null, reason: r.reason } : null,
      source: 'process', turns: card?.turns ?? null, tokens: card?.tokens != null ? { input: card.tokens, output: 0 } : null,
      startedAt: r.startedAt, lastActivityAt: null, elapsedSec: r.elapsedSec, log: null,
      pid: r.pid, runId: r.runId, stoppable: r.pid !== null,
    });
  }
  for (const s of sessions) {
    const idle = (now.getTime() - (s.endedAt ?? s.updatedAt).getTime()) / 1000;
    if (idle > ACTIVE_WINDOW_SEC) continue;
    const harness = harnessOf(s.source);
    // On the server the process list is authoritative; a synced session of the same harness would list it twice.
    if (s.host === serverMachine && procHarness.has(harness)) continue;
    const started = s.startedAt ?? null;
    agents.push({
      id: `session:${s.host}:${s.externalId}`, machine: s.host, harness, name: s.source.includes(':') ? s.source.split(':')[1]! : (s.project ?? harness),
      model: s.model, task: { cardId: null, label: s.title, reason: null }, source: 'session', turns: s.messages,
      tokens: { input: Number(s.input ?? 0), output: Number(s.output ?? 0) },
      startedAt: started?.toISOString() ?? null, lastActivityAt: (s.endedAt ?? s.updatedAt).toISOString(),
      elapsedSec: started ? Math.max(0, Math.round((now.getTime() - started.getTime()) / 1000)) : null,
      log: { host: s.host, externalId: s.externalId, source: s.source }, pid: null, runId: null, stoppable: false,
    });
  }
  const info = new Map(hosts.map((h) => [h.slug, h]));
  const slugs = [...new Set([serverMachine, ...agents.map((a) => a.machine)])];
  const machines = slugs.map((slug): LiveMachine => ({
    slug, display: info.get(slug)?.display ?? slug, kind: info.get(slug)?.kind ?? null,
    agents: agents.filter((a) => a.machine === slug).sort((a, b) => (b.elapsedSec ?? 0) - (a.elapsedSec ?? 0)),
  })).filter((m) => m.agents.length > 0 || m.slug === serverMachine);
  return { at: now.toISOString(), serverMachine, total: agents.length, machines };
}

export async function loadCards(ids: string[]): Promise<Map<string, CardRunInfo>> {
  const wanted = ids.filter((i) => /^t_[0-9a-f]{6,32}$/.test(i));
  if (!wanted.length) return new Map();
  const { rows } = await query<{ id: string; title: string; turns: number | null; tokens: string | null }>(
    `SELECT c.id, c.title, r.turns, r.tokens FROM cards c
       LEFT JOIN LATERAL (SELECT turns, tokens FROM card_runs WHERE card_id = c.id AND finished_at IS NULL ORDER BY id DESC LIMIT 1) r ON true
      WHERE c.id = ANY($1)`, [wanted]);
  return new Map(rows.map((r) => [r.id, { cardId: r.id, title: r.title, turns: r.turns, tokens: r.tokens === null ? null : Number(r.tokens) }]));
}

export async function loadRecentSessions(): Promise<SessionInfo[]> {
  const { rows } = await query<{
    host: string; source: string; external_id: string; title: string | null; model: string | null; started_at: Date | null;
    ended_at: Date | null; updated_at: Date; message_count: number; input_tokens: string | null; output_tokens: string | null; project: string | null;
  }>(`SELECT host, source, external_id, title, model, started_at, ended_at, updated_at, message_count, input_tokens, output_tokens, project
        FROM archive_sessions
       WHERE parent_external_id IS NULL AND greatest(coalesce(ended_at, updated_at), updated_at) > now() - make_interval(secs => $1)
       ORDER BY coalesce(ended_at, updated_at) DESC LIMIT 200`, [ACTIVE_WINDOW_SEC]);
  return rows.map((r) => ({ host: r.host, source: r.source, externalId: r.external_id, title: r.title, model: r.model, startedAt: r.started_at,
    endedAt: r.ended_at, updatedAt: r.updated_at, messages: r.message_count, input: r.input_tokens === null ? null : Number(r.input_tokens),
    output: r.output_tokens === null ? null : Number(r.output_tokens), project: r.project }));
}

/** The slug this server's own sessions sync under (usage_hosts.kind = 'server'), else its hostname. */
export async function serverMachineSlug(hosts: HostInfo[]): Promise<string> {
  return hosts.find((h) => h.kind === 'server')?.slug ?? hostname();
}

export async function live(): Promise<LiveNow> {
  const { rows: hostRows } = await query<HostInfo>(`SELECT slug, display, kind FROM usage_hosts ORDER BY slug`);
  const [procs, claims, roster, sessions] = await Promise.all([listProcesses(), loadClaims(), loadRoster(), loadRecentSessions()]);
  const rows = buildRunning(procs, claims, roster);
  const cards = await loadCards(rows.map((r) => r.ref ?? ''));
  return buildLive(rows, cards, sessions, hostRows, await serverMachineSlug(hostRows));
}

export type StopResult = { ok: true; pid: number; signal: 'SIGTERM' | 'SIGKILL' } | { ok: false; status: number; error: string };

/**
 * Signal a process this page listed. The pid must still be an agent process (the same filter the list uses) with the
 * same start time the caller saw, so a recycled pid is never signalled. Only this server's processes: a session on
 * another machine has no pid here.
 */
export async function stopProcess(pid: number, force: boolean, expectStartedAt?: string, now = new Date()): Promise<StopResult> {
  const procs = await listProcesses();
  const p = procs.find((x) => x.pid === pid);
  if (!p) return { ok: false, status: 404, error: 'That process is not running any more.' };
  if (expectStartedAt) {
    const started = now.getTime() - p.elapsedSec * 1000;
    if (!(Math.abs(started - Date.parse(expectStartedAt)) < 30_000)) return { ok: false, status: 409, error: 'The process on that pid changed; reload the list.' };
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(pid, signal);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return { ok: false, status: 403, error: 'This app runs as a different user than that process, so it cannot signal it.' };
    if (code === 'ESRCH') return { ok: false, status: 404, error: 'That process is not running any more.' };
    throw e;
  }
  return { ok: true, pid, signal };
}
