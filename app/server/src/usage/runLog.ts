import { basename } from 'node:path';
import type { Host } from '../archive/types.js';
import type { PlanSnapshot, PlanWindow, RunRecord, WakeReason } from './types.js';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
/** Never hand out an Invalid Date: it fails toISOString() and the database insert. */
const valid = (d: Date | null): Date | null => (d && !Number.isNaN(d.getTime()) ? d : null);
const date = (v: unknown): Date | null => (typeof v === 'string' ? valid(new Date(v)) : null);
const WINDOWS: PlanWindow[] = ['five_hour', 'seven_day'];
const ORG_FILE = /^org-([a-z0-9-]+)-\d{8}-\d{6}$/;

interface Header {
  runId: string | null; taskId: string | null; board: string | null; lane: string | null; at: Date | null;
  agent: string | null; team: string | null; work: string | null; reasons: WakeReason[]; wakeupIds: number[]; resumed: boolean | null;
}

function header(ev: any): Header {
  const reasons = Array.isArray(ev.reasons)
    ? ev.reasons.filter((r: unknown) => r && typeof r === 'object').map((r: any) => ({ reason: str(r.reason), ref: str(r.ref) ?? (num(r.ref) !== null ? String(r.ref) : null) }))
    : [];
  const wakeupIds = Array.isArray(ev.wakeup_ids) ? ev.wakeup_ids.filter((x: unknown) => Number.isInteger(x)) as number[] : [];
  return {
    runId: str(ev.run_id), taskId: str(ev.task_id), board: str(ev.board), lane: str(ev.lane), at: date(ev.at),
    agent: str(ev.agent), team: str(ev.team), work: str(ev.work), reasons, wakeupIds,
    resumed: typeof ev.resumed === 'boolean' ? ev.resumed : null,
  };
}

/**
 * A cc-runs/<run>.jsonl log holds one or more `claude -p` runs (a lane card that is
 * unblocked and retried appends to the same file; a bot's wake is one file each).
 * The dispatcher frames each run with a cc_dispatch line before it and may add a
 * cc_verify line after it. Older logs have neither: then the run id is the file
 * name (with `#n` when the file holds several runs), a bot's name comes from the
 * `org-<name>-<stamp>` file name, and times fall back to the file's mtime.
 */
export function parseRunLog(records: unknown[], host: Host, logPath: string, fileMtime: Date):
  { runs: RunRecord[]; plan: PlanSnapshot[] } {
  const base = basename(logPath, '.jsonl');
  const agentFromFile = ORG_FILE.exec(base)?.[1] ?? null;
  const runs: RunRecord[] = [];
  const plan: PlanSnapshot[] = [];
  let head: Header | null = null;
  let model: string | null = null;

  for (const ev of records as any[]) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'cc_dispatch') {
      head = header(ev);
      model = null;
    } else if (ev.type === 'system' && ev.subtype === 'init') {
      model = str(ev.model) ?? model;
    } else if (ev.type === 'rate_limit_event') {
      const w = ev.rate_limit_info?.unifiedWindows ?? {};
      for (const name of WINDOWS) {
        const u = num(w[name]?.utilization);
        if (u === null) continue;
        const resets = num(w[name]?.resetsAt);
        const observedAt = head?.at ?? valid(fileMtime);
        if (!observedAt) continue;
        plan.push({ host, origin: 'stream-json', window: name, usedPct: Math.round(u * 1000) / 10,
          resetsAt: resets === null ? null : valid(new Date(resets * 1000)), observedAt });
      }
    } else if (ev.type === 'result' && typeof ev.session_id === 'string') {
      const durationMs = num(ev.duration_ms);
      const startedAt = head?.at ?? (durationMs !== null ? valid(new Date(fileMtime.getTime() - durationMs)) : null);
      const endedAt = valid(head?.at && durationMs !== null ? new Date(head.at.getTime() + durationMs) : fileMtime);
      runs.push({
        host, runId: head?.runId ?? '', sessionId: ev.session_id, taskId: head?.taskId ?? (agentFromFile ? null : base),
        board: head?.board ?? null, lane: head?.lane ?? null,
        agentName: head?.agent ?? agentFromFile, teamSlug: head?.team ?? null, workType: head?.work ?? null,
        reasons: head?.reasons ?? [], wakeupIds: head?.wakeupIds ?? [], resumed: head?.resumed ?? null,
        model, startedAt, endedAt, durationMs, durationApiMs: num(ev.duration_api_ms),
        numTurns: num(ev.num_turns), subtype: str(ev.subtype),
        isError: typeof ev.is_error === 'boolean' ? ev.is_error : null,
        totalCostUsd: num(ev.total_cost_usd), usage: ev.usage ?? null, modelUsage: ev.modelUsage ?? null,
        verify: null, logPath,
      });
      head = null;    // a second result without its own header is another, unframed run
    } else if (ev.type === 'cc_verify' && runs.length) {
      runs[runs.length - 1]!.verify = {
        name: str(ev.name) ?? 'unknown', passed: ev.passed === true, exitCode: num(ev.exit_code),
        metric: num(ev.metric), output: typeof ev.output === 'string' ? ev.output.slice(0, 4000) : '', at: date(ev.at),
      };
    }
  }
  // Runs without a run id in their header: the file name, numbered when the file holds more than one.
  const unnamed = runs.filter((r) => !r.runId);
  unnamed.forEach((r, i) => { r.runId = unnamed.length > 1 ? `${base}#${i + 1}` : base; });
  return { runs, plan };
}
