import { existsSync, readFileSync } from 'node:fs';
import { query } from './db.js';

/**
 * Prepaid API credits (provider_credit_snapshots). OpenRouter and fal have balance
 * APIs; Gemini doesn't (AI Studio shows it, nothing else does), so its balance is
 * typed in by hand. A failed reading is stored as an error, never as 0.
 */
export const PROVIDERS = ['openrouter', 'fal', 'gemini'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface CreditReading {
  provider: Provider;
  origin: 'api' | 'manual';
  status: 'ok' | 'error' | 'unsupported';
  balance: number | null;
  totalCredits: number | null;
  totalUsage: number | null;
  currency: string;
  error: string | null;
  note: string | null;
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 15000;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

const reading = (provider: Provider, over: Partial<CreditReading>): CreditReading => ({
  provider, origin: 'api', status: 'ok', balance: null, totalCredits: null, totalUsage: null,
  currency: 'USD', error: null, note: null, ...over,
});

async function getJson(f: Fetch, url: string, auth: string): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await f(url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let body: any = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, body };
}

const apiError = (status: number, body: any): string => {
  const msg = body?.error?.message ?? body?.message;
  return `HTTP ${status}${typeof msg === 'string' ? `: ${msg.slice(0, 200)}` : ''}`;
};

/** GET /api/v1/credits: credits bought and used, account-wide, in USD. */
export async function readOpenRouter(key: string | undefined, f: Fetch = fetch): Promise<CreditReading> {
  if (!key) return reading('openrouter', { status: 'unsupported', error: 'OPENROUTER_API_KEY not set' });
  try {
    const r = await getJson(f, 'https://openrouter.ai/api/v1/credits', `Bearer ${key}`);
    const total = num(r.body?.data?.total_credits);
    const used = num(r.body?.data?.total_usage);
    if (!r.ok || total === null || used === null) return reading('openrouter', { status: 'error', error: apiError(r.status, r.body) });
    return reading('openrouter', { balance: round4(total - used), totalCredits: total, totalUsage: used });
  } catch (err) {
    return reading('openrouter', { status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

/** GET /v1/account/billing?expand=credits. Needs a key with billing:usage:read (Billing or Read-only preset). */
export async function readFal(key: string | undefined, f: Fetch = fetch): Promise<CreditReading> {
  if (!key) return reading('fal', { status: 'unsupported', error: 'FAL_BILLING_KEY not set (needs a fal key with the Billing or Read-only scope)' });
  try {
    const r = await getJson(f, 'https://api.fal.ai/v1/account/billing?expand=credits', `Key ${key}`);
    const balance = num(r.body?.credits?.current_balance);
    if (!r.ok || balance === null) return reading('fal', { status: 'error', error: apiError(r.status, r.body) });
    const currency = typeof r.body.credits.currency === 'string' ? r.body.credits.currency : 'USD';
    return reading('fal', { balance, currency });
  } catch (err) {
    return reading('fal', { status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

/** Only these names are taken from a dotenv file; the rest of it is never loaded. */
export const KEY_NAMES = ['OPENROUTER_API_KEY', 'FAL_BILLING_KEY'] as const;

export function readKeys(env: NodeJS.ProcessEnv, file: string | undefined): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  const fromFile: Record<string, string> = {};
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || !(KEY_NAMES as readonly string[]).includes(m[1]!)) continue;
      fromFile[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  for (const k of KEY_NAMES) out[k] = env[k] || fromFile[k] || undefined;
  return out;
}

export async function collect(keys: Record<string, string | undefined>, f: Fetch = fetch): Promise<CreditReading[]> {
  return Promise.all([readOpenRouter(keys.OPENROUTER_API_KEY, f), readFal(keys.FAL_BILLING_KEY, f)]);
}

const HOURLY_MS = 3600_000;

/**
 * Store a reading if it differs from the provider's last row, or the last row is
 * over an hour old: a flat balance still gets an hourly point on the chart.
 */
export async function saveReading(r: CreditReading, now = new Date()): Promise<boolean> {
  const { rows } = await query<{ status: string; balance: string | null; error: string | null; observed_at: Date }>(
    `SELECT status, balance, error, observed_at FROM provider_credit_snapshots
     WHERE provider = $1 ORDER BY observed_at DESC LIMIT 1`, [r.provider]);
  const last = rows[0];
  const same = last && last.status === r.status && last.error === r.error
    && (last.balance === null ? r.balance === null : r.balance !== null && Number(last.balance) === round4(r.balance));
  if (r.origin === 'api' && same && now.getTime() - last.observed_at.getTime() < HOURLY_MS) return false;
  await query(
    `INSERT INTO provider_credit_snapshots
       (provider, origin, status, observed_at, balance, total_credits, total_usage, currency, error, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [r.provider, r.origin, r.status, now, r.balance, r.totalCredits, r.totalUsage, r.currency, r.error, r.note]);
  return true;
}

export interface CreditRow {
  provider: Provider; origin: string; status: string; observed_at: Date; balance: number | null;
  total_credits: number | null; total_usage: number | null; currency: string; error: string | null; note: string | null;
}

const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const shape = (r: Record<string, unknown>): CreditRow => ({
  ...(r as unknown as CreditRow), balance: toNum(r.balance), total_credits: toNum(r.total_credits), total_usage: toNum(r.total_usage),
});

/**
 * The latest row per provider, and the last good balance when the latest reading failed,
 * so the board can say "last known $7.94, 2 h ago" instead of going blank.
 */
export async function latestCredits(): Promise<{ provider: Provider; latest: CreditRow | null; last_ok: CreditRow | null }[]> {
  const latest = await query(
    `SELECT DISTINCT ON (provider) * FROM provider_credit_snapshots ORDER BY provider, observed_at DESC`);
  const ok = await query(
    `SELECT DISTINCT ON (provider) * FROM provider_credit_snapshots WHERE status = 'ok' ORDER BY provider, observed_at DESC`);
  return PROVIDERS.map((p) => ({
    provider: p,
    latest: (() => { const r = latest.rows.find((x) => x.provider === p); return r ? shape(r) : null; })(),
    last_ok: (() => { const r = ok.rows.find((x) => x.provider === p); return r ? shape(r) : null; })(),
  }));
}

export async function creditHistory(from: Date, to: Date): Promise<{ provider: Provider; observed_at: Date; balance: number; currency: string }[]> {
  const { rows } = await query(
    `SELECT provider, observed_at, balance, currency FROM provider_credit_snapshots
     WHERE status = 'ok' AND observed_at >= $1 AND observed_at < $2 ORDER BY observed_at`, [from, to]);
  return rows.map((r) => ({ ...r, balance: Number(r.balance) })) as never;
}
