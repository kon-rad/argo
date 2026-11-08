import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { query } from '../db.js';
import { subscriptionEnv } from '../addons/dispatch/codex.js';

export type SubscriptionProvider = 'codex' | 'claude-code';
export interface QuotaWindow {
  key: string; label: string; window_minutes: number; used_pct: number | null; left_pct: number | null;
  resets_at: string | null; observed_at: string | null; reset_since_reading: boolean; last_pct: number | null;
}
export interface SubscriptionUsage {
  provider: SubscriptionProvider; label: string; status: 'ok' | 'unavailable'; observed_at: string | null;
  source: string; message: string | null; stale: boolean; windows: QuotaWindow[];
}

const TTL_MS = 60_000;
const TIMEOUT_MS = 8_000;
const OUTPUT_MAX = 512_000;
const asObject = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const iso = (v: unknown): string | null => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < 8.64e12
  ? new Date(v * 1000).toISOString() : null;
const percent = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
const safeKey = (v: string): string => v.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64);

function windowValue(raw: unknown, bucket: string, slot: string, observedAt: string, now: Date): QuotaWindow | null {
  const w = asObject(raw);
  if (!w) return null;
  const duration = w.windowDurationMins;
  const used = percent(w.usedPercent);
  if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration <= 0 || duration > 525_600 || used === null) return null;
  const resets = w.resetsAt === null || w.resetsAt === undefined ? null : iso(w.resetsAt);
  if (w.resetsAt !== null && w.resetsAt !== undefined && !resets) return null;
  const expired = resets !== null && Date.parse(resets) <= now.getTime();
  const label = duration === 300 ? '5-hour' : duration === 10080 ? 'Weekly' : `${duration}-minute`;
  const bucketLabel = safeKey(bucket) || 'meter';
  return { key: `${bucketLabel}:${duration}:${slot}`, label: bucket === 'default' ? label : `${bucketLabel} ${label}`,
    window_minutes: duration, used_pct: expired ? null : used, left_pct: expired ? null : Math.round((100 - used) * 10) / 10,
    resets_at: resets, observed_at: observedAt, reset_since_reading: expired, last_pct: used };
}

/** Parse documented app-server rateLimits/read fields; each metered bucket is retained. */
export function parseCodexRateLimits(raw: unknown, observedAt: string, now = new Date()): QuotaWindow[] {
  const response = asObject(raw);
  if (!response) return [];
  const multi = asObject(response.rateLimitsByLimitId);
  const buckets: [string, unknown][] = multi && Object.keys(multi).length
    ? Object.entries(multi) : [['default', response.rateLimits]];
  const windows: QuotaWindow[] = [];
  for (const [name, value] of buckets) {
    const bucket = asObject(value);
    if (!bucket) continue;
    for (const slot of ['primary', 'secondary']) {
      const w = windowValue(bucket[slot], name, slot, observedAt, now);
      if (w) windows.push(w);
    }
  }
  return windows;
}

type Rpc = { id?: number; result?: unknown; error?: unknown };

/** A short-lived, read-only app-server session. No model turns or tools are requested. */
export function readCodexRpc(command = config.orgCodexCommand ?? 'codex', now = new Date(), timeoutMs = TIMEOUT_MS): Promise<SubscriptionUsage> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    const unavailable = (message: string): SubscriptionUsage => ({ provider: 'codex', label: 'Codex', status: 'unavailable',
      observed_at: null, source: 'codex app-server', message, stale: false, windows: [] });
    try {
      child = spawn(command, ['app-server', '--stdio'], { env: subscriptionEnv(process.env), stdio: ['pipe', 'pipe', 'ignore'],
        detached: process.platform !== 'win32' });
    } catch { resolve(unavailable('Codex CLI unavailable')); return; }
    let done = false;
    let bytes = 0;
    let buffer = '';
    let stage = 0;
    const stop = (result: SubscriptionUsage) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
      resolve(result);
    };
    const send = (value: object) => { try { child.stdin?.write(`${JSON.stringify(value)}\n`); } catch { stop(unavailable('Codex CLI unavailable')); } };
    const timer = setTimeout(() => stop(unavailable('Codex quota read timed out')), timeoutMs);
    child.on('error', () => stop(unavailable('Codex CLI unavailable')));
    child.on('exit', () => stop(unavailable('Codex quota read unavailable')));
    child.stdin?.on('error', () => stop(unavailable('Codex CLI unavailable')));
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_MAX) { stop(unavailable('Codex quota response too large')); return; }
      buffer += chunk.toString('utf8');
      let end: number;
      while (!done && (end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let msg: Rpc | null;
        try { msg = asObject(JSON.parse(line)) as Rpc | null; } catch { continue; }
        if (!msg) continue;
        if (msg.id !== stage + 1) continue;
        if (msg.error) { stop(unavailable('Codex quota read unavailable')); return; }
        if (stage === 0) {
          stage = 1;
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/read', params: { refreshToken: false } });
        } else if (stage === 1) {
          const account = asObject(asObject(msg.result)?.account);
          if (account?.type !== 'chatgpt') { stop(unavailable('Codex requires ChatGPT subscription login')); return; }
          stage = 2;
          send({ id: 3, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
        } else {
          const observedAt = now.toISOString();
          const windows = parseCodexRateLimits(msg.result, observedAt, now);
          const missing = [[300, '5-hour'], [10080, 'Weekly']] as const;
          const unreported = missing.filter(([minutes]) => !windows.some((w) => w.window_minutes === minutes)).map(([, label]) => label);
          stop({ provider: 'codex', label: 'Codex', status: 'ok', observed_at: observedAt, source: 'codex app-server',
            message: !windows.length ? 'No quota windows reported for this plan'
              : unreported.length ? `${unreported.join(' and ')} quota window not reported for this account` : null, stale: false, windows });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'secondbrain-usage', version: '1.0.0' }, capabilities: {} } });
  });
}

let cached: { until: number; value: SubscriptionUsage; stale: boolean } | null = null;
let inflight: Promise<SubscriptionUsage> | null = null;
export function resetCodexQuotaCache(): void { cached = null; inflight = null; }

function age(value: SubscriptionUsage, now: Date, stale: boolean): SubscriptionUsage {
  return { ...value, stale, windows: value.windows.map((w) => {
    const expired = w.resets_at !== null && Date.parse(w.resets_at) <= now.getTime();
    return { ...w, used_pct: expired ? null : w.used_pct, left_pct: expired ? null : w.left_pct,
      reset_since_reading: expired || w.reset_since_reading };
  }) };
}

export async function codexSubscription(now = new Date(), reader = readCodexRpc): Promise<SubscriptionUsage> {
  if (cached && now.getTime() < cached.until) return age(cached.value, now, cached.stale);
  inflight ??= Promise.resolve().then(() => reader(undefined, now)).catch((): SubscriptionUsage => ({
    provider: 'codex', label: 'Codex', status: 'unavailable', observed_at: null,
    source: 'codex app-server', message: 'Codex quota read unavailable', stale: false, windows: [],
  })).then((value) => {
    if (value.status === 'ok') { cached = { value, until: now.getTime() + TTL_MS, stale: false }; return value; }
    if (cached?.value.status === 'ok') {
      cached.until = now.getTime() + TTL_MS;
      cached.stale = true;
      cached.value = { ...cached.value, message: value.message };
      return age(cached.value, now, true);
    }
    cached = { value, until: now.getTime() + TTL_MS, stale: false };
    return value;
  }).finally(() => { inflight = null; });
  return inflight;
}

export async function claudeSubscription(now = new Date()): Promise<SubscriptionUsage> {
  const { rows } = await query<{ window: string; used_pct: number; resets_at: Date | null; observed_at: Date }>(
    `SELECT DISTINCT ON ("window") "window", used_pct, resets_at, observed_at
     FROM plan_usage_snapshots ORDER BY "window", observed_at DESC`);
  const windows = rows.flatMap((r): QuotaWindow[] => {
    const duration = r.window === 'five_hour' ? 300 : r.window === 'seven_day' ? 10080 : null;
    if (!duration) return [];
    const resets = r.resets_at?.toISOString() ?? null;
    const expired = resets !== null && Date.parse(resets) <= now.getTime();
    return [{ key: r.window, label: duration === 300 ? '5-hour' : 'Weekly', window_minutes: duration,
      used_pct: expired ? null : r.used_pct, left_pct: expired ? null : Math.round((100 - r.used_pct) * 10) / 10,
      resets_at: resets, observed_at: r.observed_at.toISOString(), reset_since_reading: expired, last_pct: r.used_pct }];
  });
  return { provider: 'claude-code', label: 'Claude Code', status: rows.length ? 'ok' : 'unavailable',
    observed_at: rows.length ? new Date(Math.max(...rows.map((r) => r.observed_at.getTime()))).toISOString() : null,
    source: 'plan_usage_snapshots', message: windows.length ? null : 'No quota windows recorded', stale: false, windows };
}
