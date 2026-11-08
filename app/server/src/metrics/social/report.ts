import { query } from '../../db.js';
import type { SocialMetricsSettings } from '../../settings.js';
import { socialAccounts, type Platform } from './accounts.js';
import { utcDay } from './store.js';

/**
 * `secondbrain metrics social`: follower changes and the week's top posts,
 * with every number's age. A stale or missing account is shown as such and
 * left out of the follower total, which then says it is incomplete; a post
 * without a baseline or without views is counted, never ranked as 0.
 */

const HOUR = 3_600_000;

export interface AccountLine {
  platform: Platform;
  label: string;
  metric: string;
  value: number | null;
  sampledAt: Date | null;
  ageHours: number | null;
  staleHours: number;
  stale: boolean;
  missing: boolean;
  delta: number | null;
  /** When the delta's baseline reading was taken. */
  deltaSince: Date | null;
  /** The first reading came after the window started, so the delta covers less than the window. */
  deltaPartial: boolean;
  lastError: string | null;
  lastErrorAt: Date | null;
}

export interface PostLine {
  platform: Platform;
  account: string;
  externalId: string;
  url: string | null;
  postedAt: Date | null;
  views: number;
  viewsGained: number;
  likes: number | null;
  comments: number | null;
  day: string;
  sampledAt: Date;
  stale: boolean;
}

export interface SocialReport {
  now: Date;
  days: number;
  since: Date;
  accounts: AccountLine[];
  total: { value: number; complete: boolean; counted: number; of: number; excluded: string[] };
  topPosts: PostLine[];
  postsWithoutBaseline: number;
  postsWithoutViews: number;
}

export async function socialReport(s: SocialMetricsSettings, opts: { now?: Date; days?: number; top?: number } = {}): Promise<SocialReport> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 7;
  const since = new Date(now.getTime() - days * 24 * HOUR);
  const accounts = socialAccounts(s);

  const { rows: status } = await query<{ collector: string; last_error: string | null; last_error_at: Date | null }>(
    `SELECT collector, last_error, last_error_at FROM social_metric_status`);
  const statusBy = new Map(status.map((r) => [r.collector, r]));

  const lines: AccountLine[] = [];
  for (const a of accounts) {
    const latest = (await query<{ value: string; sampled_at: Date }>(
      `SELECT value::text, sampled_at FROM metric_samples WHERE metric = $1 AND sampled_at <= $2 ORDER BY sampled_at DESC LIMIT 1`,
      [a.followersMetric, now])).rows[0];
    let base = (await query<{ value: string; sampled_at: Date }>(
      `SELECT value::text, sampled_at FROM metric_samples WHERE metric = $1 AND sampled_at <= $2 ORDER BY sampled_at DESC LIMIT 1`,
      [a.followersMetric, since])).rows[0];
    let partial = false;
    if (!base && latest) {
      base = (await query<{ value: string; sampled_at: Date }>(
        `SELECT value::text, sampled_at FROM metric_samples WHERE metric = $1 AND sampled_at > $2 AND sampled_at < $3 ORDER BY sampled_at LIMIT 1`,
        [a.followersMetric, since, latest.sampled_at])).rows[0];
      partial = Boolean(base);
    }
    const st = statusBy.get(a.collector);
    const age = latest ? (now.getTime() - latest.sampled_at.getTime()) / HOUR : null;
    lines.push({
      platform: a.platform, label: a.label, metric: a.followersMetric,
      value: latest ? Number(latest.value) : null,
      sampledAt: latest?.sampled_at ?? null,
      ageHours: age,
      staleHours: a.staleHours,
      stale: age !== null && age > a.staleHours,
      missing: !latest,
      delta: latest && base ? Number(latest.value) - Number(base.value) : null,
      deltaSince: base?.sampled_at ?? null,
      deltaPartial: partial,
      lastError: st?.last_error ?? null,
      lastErrorAt: st?.last_error_at ?? null,
    });
  }

  const fresh = lines.filter((l) => !l.missing && !l.stale);
  const total = {
    value: fresh.reduce((sum, l) => sum + l.value!, 0),
    complete: fresh.length === lines.length,
    counted: fresh.length,
    of: lines.length,
    excluded: lines.filter((l) => l.missing || l.stale).map((l) => `${l.metric} (${l.missing ? 'no reading' : 'stale'})`),
  };

  const staleFor = new Map(accounts.map((a) => [`${a.platform}:${a.account}`, a.staleHours]));
  const startDay = utcDay(since);
  const { rows } = await query<{
    platform: Platform; account: string; external_id: string; url: string | null; posted_at: Date | null;
    views: string | null; likes: string | null; comments: string | null; day: string; sampled_at: Date;
    has_base: boolean; base_views: string | null;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (platform, external_id) * FROM social_post_stats
        WHERE day > $1::date AND day <= $2::date ORDER BY platform, external_id, day DESC),
     base AS (
       SELECT DISTINCT ON (platform, external_id) platform, external_id, views FROM social_post_stats
        WHERE day <= $1::date ORDER BY platform, external_id, day DESC)
     SELECT l.platform, l.account, l.external_id, l.url, l.posted_at, l.views::text, l.likes::text, l.comments::text,
            to_char(l.day, 'YYYY-MM-DD') AS day, l.sampled_at, (b.external_id IS NOT NULL) AS has_base, b.views::text AS base_views
       FROM latest l LEFT JOIN base b USING (platform, external_id)`,
    [startDay, utcDay(now)],
  );
  let noBaseline = 0;
  let noViews = 0;
  const posts: PostLine[] = [];
  for (const r of rows) {
    if (r.views === null) { noViews++; continue; }
    const views = Number(r.views);
    let gained: number;
    if (r.has_base && r.base_views !== null) gained = views - Number(r.base_views);
    else if (r.posted_at && r.posted_at.getTime() >= since.getTime()) gained = views; // published inside the window: from 0
    else { noBaseline++; continue; }
    const staleHours = staleFor.get(`${r.platform}:${r.account}`) ?? s.staleHours;
    posts.push({
      platform: r.platform, account: r.account, externalId: r.external_id, url: r.url, postedAt: r.posted_at,
      views, viewsGained: gained,
      likes: r.likes === null ? null : Number(r.likes), comments: r.comments === null ? null : Number(r.comments),
      day: r.day, sampledAt: r.sampled_at, stale: (now.getTime() - r.sampled_at.getTime()) / HOUR > staleHours,
    });
  }
  posts.sort((x, y) => y.viewsGained - x.viewsGained || x.externalId.localeCompare(y.externalId));

  return { now, days, since, accounts: lines, total, topPosts: posts.slice(0, opts.top ?? 10), postsWithoutBaseline: noBaseline, postsWithoutViews: noViews };
}

const stamp = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const age = (h: number) => (h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const n = (v: number | null) => (v === null ? '-' : String(v));

export const DEFINITIONS = [
  'followers: the platform\'s own follower (YouTube: subscriber) count at the last reading; YouTube rounds counts above 1,000.',
  'delta: the last reading minus the last reading at or before the window start. "from <date>" means the first reading came later, so the delta covers less than the window.',
  'stale: the last reading is older than the account\'s staleHours (default 36 h; LinkedIn, entered by hand, 192 h). Stale and missing accounts are never added to the total.',
  'views gained: the post\'s latest views in the window minus its views on the last day at or before the window start; a post published inside the window counts from 0.',
  'views: YouTube viewCount, Instagram insights "views", X views from fxtwitter, LinkedIn as entered by hand. A post with no views reading, or no baseline, is counted below the list, never ranked as 0.',
];

export function formatSocialReport(r: SocialReport): string {
  const out: string[] = [];
  out.push(`Social metrics, ${r.days} days: ${stamp(r.since)} to ${stamp(r.now)}`, '');
  if (!r.accounts.length) out.push('No accounts configured (socialMetrics in secondbrain.json).');
  else {
    out.push('Accounts');
    for (const a of r.accounts) {
      const delta = a.delta === null ? 'delta n/a' : `${signed(a.delta)}${a.deltaPartial ? ` from ${a.deltaSince!.toISOString().slice(0, 10)}` : ''}`;
      const state = a.missing ? 'MISSING' : a.stale ? `STALE (${age(a.ageHours!)} old, limit ${a.staleHours}h)` : `ok (${age(a.ageHours!)} old)`;
      const when = a.sampledAt ? stamp(a.sampledAt) : 'never';
      out.push(`  ${a.platform.padEnd(9)} ${a.metric.padEnd(34)} ${n(a.value).padStart(8)}  ${delta.padEnd(18)} ${when}  ${state}`);
      if (a.lastError) out.push(`            last error${a.lastErrorAt ? ` ${stamp(a.lastErrorAt)}` : ''}: ${a.lastError}`);
    }
    out.push('');
    out.push(r.total.complete
      ? `Total followers: ${r.total.value} (all ${r.total.of} accounts current)`
      : `Total followers: incomplete, ${r.total.value} from ${r.total.counted} of ${r.total.of} accounts; left out: ${r.total.excluded.join(', ')}`);
  }
  out.push('', `Top posts by views gained since ${stamp(r.since)}`);
  if (!r.topPosts.length) out.push('  none with a views reading in the window');
  for (const [i, p] of r.topPosts.entries()) {
    out.push(`  ${String(i + 1).padStart(2)}. ${signed(p.viewsGained).padStart(8)} views (${p.views} total, likes ${n(p.likes)}, comments ${n(p.comments)})  ${p.platform} ${p.account}  ${p.url ?? p.externalId}  read ${p.day}${p.stale ? '  STALE' : ''}`);
  }
  if (r.postsWithoutBaseline || r.postsWithoutViews) {
    out.push(`  not ranked: ${r.postsWithoutBaseline} published before the window with no earlier reading, ${r.postsWithoutViews} with no views reading`);
  }
  out.push('', 'Definitions', ...DEFINITIONS.map((d) => `  - ${d}`));
  return out.join('\n');
}
