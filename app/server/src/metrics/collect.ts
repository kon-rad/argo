import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '../db.js';
import { metricDef, metrics, type MetricDef } from './registry.js';

/**
 * Daily collectors for the brain map's numbers, one per metric with a
 * `collect` entry in secondbrain.json. No API keys: public pages and
 * endpoints only, fetched with curl, which some servers' outbound paths
 * tolerate better than Node's fetch (see livestream.ts). A source that fails
 * writes nothing; the map then shows the last value with its age, never a 0.
 */

export type HttpGet = (url: string, headers?: Record<string, string>) => Promise<{ status: number; body: string }>;

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

export const curlGet: HttpGet = (url, headers = {}) =>
  new Promise((resolve, reject) => {
    const args = ['-sS', '-m', '20', '-L', '-w', '\n%{http_code}'];
    if (!headers['user-agent']) args.push('-A', BROWSER_UA);
    for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
    execFile('curl', [...args, url], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`curl: ${err.message.split('\n')[0]}`));
      const cut = stdout.lastIndexOf('\n');
      resolve({ status: Number(stdout.slice(cut + 1)), body: stdout.slice(0, cut) });
    });
  });

export interface Sample { metric: string; source: string; value: number; raw?: unknown }

/** "36", "1,204", "1.2K", "3.4M" -> number. YouTube rounds above 1,000. */
export function parseCount(text: string): number {
  const m = /^([\d.,]+)\s*([KkMm])?$/.exec(text.trim());
  if (!m) throw new Error(`not a count: ${text}`);
  const n = Number(m[1]!.replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new Error(`not a count: ${text}`);
  const mult = m[2]?.toLowerCase() === 'k' ? 1_000 : m[2]?.toLowerCase() === 'm' ? 1_000_000 : 1;
  return Math.round(n * mult);
}

export function parseFxTwitter(body: string): number {
  const d = JSON.parse(body) as { code?: number; user?: { followers?: number } };
  if (typeof d.user?.followers !== 'number') throw new Error(`fxtwitter: no followers (code ${d.code ?? '?'})`);
  return d.user.followers;
}

/** The channel page's header says "36 subscribers"; the first occurrence is the channel's own. */
export function parseYouTubeChannel(html: string): number {
  const m = /"((?:[\d.,]+[KM]?)) subscribers?"/.exec(html);
  if (!m) throw new Error('YouTube: no subscriber count on the page (consent wall or a hidden count?)');
  return parseCount(m[1]!);
}

/** Link-preview HTML carries `content="39 Followers, 33 Following, 9 Posts - ..."`. */
export function parseInstagramMeta(html: string): number {
  const m = /content="([\d.,]+[KkMm]?) Followers/.exec(html);
  if (!m) throw new Error('Instagram: no follower count in the page meta (login wall?)');
  return parseCount(m[1]!);
}

const ok = (r: { status: number; body: string }, what: string) => {
  if (r.status !== 200) throw new Error(`${what}: HTTP ${r.status}`);
  return r.body;
};

export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_RPC = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';

export type RpcCall = (method: string, params: unknown[]) => Promise<string>;

export const curlRpc: RpcCall = (method, params) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    execFile('curl', ['-sS', '-m', '20', '-H', 'content-type: application/json', '-d', body, BASE_RPC], (err, stdout) => {
      if (err) return reject(new Error(`rpc: ${err.message.split('\n')[0]}`));
      try {
        const j = JSON.parse(stdout) as { result?: string; error?: { message: string } };
        if (j.error || typeof j.result !== 'string') return reject(new Error(`rpc ${method}: ${j.error?.message ?? 'no result'}`));
        resolve(j.result);
      } catch { reject(new Error(`rpc ${method}: bad JSON`)); }
    });
  });

/** A vault JSON file's `safe` field (e.g. a fund's state file); null until it holds an address. */
export function addressFromFile(vaultRoot: string, file: string): string | null {
  try {
    const cfg = JSON.parse(readFileSync(join(vaultRoot, file), 'utf8')) as { safe?: string };
    return cfg.safe && /^0x[0-9a-fA-F]{40}$/.test(cfg.safe) ? cfg.safe : null;
  } catch {
    return null;
  }
}

/** ETH + USDC on Base, in USD. ETH priced from Coinbase's public spot price; USDC at 1. */
export async function baseBalanceUsd(safe: string, rpc: RpcCall, get: HttpGet): Promise<{ usd: number; eth: number; usdc: number; ethUsd: number }> {
  const wei = BigInt(await rpc('eth_getBalance', [safe, 'latest']));
  const data = `0x70a08231${safe.slice(2).toLowerCase().padStart(64, '0')}`;
  const usdcRaw = BigInt(await rpc('eth_call', [{ to: BASE_USDC, data }, 'latest']));
  const price = JSON.parse(ok(await get('https://api.coinbase.com/v2/prices/ETH-USD/spot'), 'coinbase')) as { data?: { amount?: string } };
  const ethUsd = Number(price.data?.amount);
  if (!Number.isFinite(ethUsd) || ethUsd <= 0) throw new Error('coinbase: no ETH-USD price');
  const eth = Number(wei) / 1e18;
  const usdc = Number(usdcRaw) / 1e6;
  return { usd: Math.round((eth * ethUsd + usdc) * 100) / 100, eth, usdc, ethUsd };
}

export interface Collector { metric: string; source: string; run: () => Promise<{ value: number; raw?: unknown }> }

export function collectors(
  vaultRoot: string,
  get: HttpGet = curlGet,
  rpc: RpcCall = curlRpc,
  list: readonly MetricDef[] = metrics(),
): Collector[] {
  return list.flatMap((m): Collector[] => {
    const c = m.collect;
    if (!c) return [];
    switch (c.type) {
      case 'youtube':
        return [{ metric: m.key, source: 'youtube-page',
          run: async () => ({ value: parseYouTubeChannel(ok(await get(`https://www.youtube.com/@${c.handle}`, { 'accept-language': 'en-US,en;q=0.9' }), 'YouTube')) }) }];
      case 'x':
        return [{ metric: m.key, source: 'fxtwitter',
          run: async () => ({ value: parseFxTwitter(ok(await get(`https://api.fxtwitter.com/${c.handle}`), 'fxtwitter')) }) }];
      case 'instagram':
        // The link-preview crawler's user agent gets the server-rendered meta tags without a login wall.
        return [{ metric: m.key, source: 'instagram-meta',
          run: async () => ({ value: parseInstagramMeta(ok(await get(`https://www.instagram.com/${c.handle}/`, { 'user-agent': 'facebookexternalhit/1.1' }), 'Instagram')) }) }];
      case 'base-balance':
        return [{ metric: m.key, source: 'base-rpc',
          run: async () => {
            const address = c.address ?? (c.addressFile ? addressFromFile(vaultRoot, c.addressFile) : null);
            if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('no address configured yet');
            const r = await baseBalanceUsd(address, rpc, get);
            return { value: r.usd, raw: { address, ...r } };
          } }];
    }
  });
}

export interface CollectResult { metric: string; value?: number; error?: string }

export async function collectAll(list: Collector[], write = true): Promise<CollectResult[]> {
  const out: CollectResult[] = [];
  for (const c of list) {
    try {
      const { value, raw } = await c.run();
      if (write) await insertSample({ metric: c.metric, source: c.source, value, raw });
      out.push({ metric: c.metric, value });
    } catch (err) {
      out.push({ metric: c.metric, error: (err as Error).message });
    }
  }
  return out;
}

export async function insertSample(s: Sample): Promise<void> {
  const def = metricDef(s.metric);
  if (!def) throw new Error(`unknown metric ${s.metric}; known: ${metrics().map((m) => m.key).join(', ') || 'none (add them to secondbrain.json)'}`);
  if (def.derived || def.sum) throw new Error(`${s.metric} is computed, not stored`);
  await query(
    `INSERT INTO metric_samples (metric, source, value, unit, currency, raw) VALUES ($1, $2, $3, $4, $5, $6)`,
    [s.metric, s.source, s.value, def.unit, def.money ? 'USD' : null, s.raw === undefined ? null : JSON.stringify(s.raw)],
  );
}

export interface MetricView {
  key: string;
  label: string;
  unit: string;
  currency: string | null;
  money: boolean;
  goal: string | null;
  target: number | null;
  value: number | null;
  sampledAt: string | null;
  source: string | null;
  placeholder: boolean;
  headline: boolean;
  /** Daily points for the last 30 days (latest per day). */
  series: { day: string; value: number }[];
}

/** Latest value and 30-day series for every metric, derived ones included. */
export async function metricViews(now = new Date()): Promise<MetricView[]> {
  const { rows } = await query<{ metric: string; day: string; value: string; sampled_at: string; source: string }>(
    `SELECT DISTINCT ON (metric, day) metric, day, value::text, sampled_at::text, source
       FROM (SELECT *, to_char(sampled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM metric_samples
              WHERE sampled_at > $1::timestamptz - interval '30 days') s
      ORDER BY metric, day, sampled_at DESC`,
    [now.toISOString()],
  );
  const series = new Map<string, { day: string; value: number; at: string; source: string }[]>();
  for (const r of rows) series.set(r.metric, [...(series.get(r.metric) ?? []), { day: r.day, value: Number(r.value), at: r.sampled_at, source: r.source }]);

  // Last-ever value too: a metric not sampled for 30 days still shows, with its age.
  const { rows: latest } = await query<{ metric: string; value: string; sampled_at: string; source: string }>(
    `SELECT DISTINCT ON (metric) metric, value::text, sampled_at::text, source FROM metric_samples ORDER BY metric, sampled_at DESC`);
  const last = new Map(latest.map((r) => [r.metric, r]));

  const hours = await livestreamHours30d(now);

  return metrics().map((m) => {
    const base = {
      key: m.key, label: m.label, unit: m.unit, currency: m.money ? 'USD' : null, money: m.money,
      goal: m.goal ?? null, target: m.target ?? null, placeholder: m.placeholder, headline: m.headline,
    };
    if (m.derived === 'livestream-hours-30d') {
      return { ...base, value: hours, sampledAt: now.toISOString(), source: 'livestream_sessions', series: [] };
    }
    if (m.sum) {
      const keys = m.sum;
      const have = keys.map((k) => last.get(k)).filter(Boolean);
      const byDay = new Map<string, number>();
      for (const k of keys) for (const p of series.get(k) ?? []) byDay.set(p.day, (byDay.get(p.day) ?? 0) + p.value);
      return {
        ...base,
        // A partial sum would undercount; show it only when every part has a reading.
        value: have.length === keys.length ? have.reduce((s, r) => s + Number(r!.value), 0) : null,
        sampledAt: have.length ? have.map((r) => r!.sampled_at).sort()[0]! : null,
        source: 'sum',
        series: [...byDay].sort().map(([day, value]) => ({ day, value })),
      };
    }
    const l = last.get(m.key);
    return {
      ...base,
      value: l ? Number(l.value) : null,
      sampledAt: l?.sampled_at ?? null,
      source: l?.source ?? null,
      series: (series.get(m.key) ?? []).map(({ day, value }) => ({ day, value })),
    };
  });
}

/** Union of stream intervals in the last 30 days, like the livestream page counts them. */
export async function livestreamHours30d(now: Date): Promise<number> {
  const { rows } = await query<{ s: Date; e: Date }>(
    `SELECT GREATEST(started_at, $1::timestamptz - interval '30 days') AS s, COALESCE(ended_at, last_seen_at) AS e
       FROM livestream_sessions WHERE COALESCE(ended_at, last_seen_at) > $1::timestamptz - interval '30 days' ORDER BY 1`,
    [now.toISOString()],
  );
  let total = 0;
  let curS = 0;
  let curE = 0;
  for (const r of rows) {
    const s = new Date(r.s).getTime();
    const e = new Date(r.e).getTime();
    if (e <= s) continue;
    if (s > curE) { total += curE - curS; curS = s; curE = e; } else curE = Math.max(curE, e);
  }
  total += curE - curS;
  return Math.round((total / 3_600_000) * 10) / 10;
}
