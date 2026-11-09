import type { SocialMetricsSettings } from '../../settings.js';

/**
 * The owner's social accounts, from `socialMetrics` in secondbrain.json, with
 * the metric_samples keys each one writes. Keys default from the handle
 * (lower-cased), so correcting a wrong handle starts a new key and the old
 * account's history stays under the old one, untouched.
 */

export type Platform = 'youtube' | 'instagram' | 'x' | 'linkedin';

type Cfg = SocialMetricsSettings;
export type YouTubeCfg = Cfg['youtube'][number];
export type InstagramCfg = Cfg['instagram'][number];
export type XCfg = Cfg['x'][number];
export type LinkedInCfg = Cfg['linkedin'][number];

export interface AccountMetric { metric: string; unit: 'followers' | 'subscribers' | 'count' }

interface Base {
  /** `<platform>:<key>`: the row in social_metric_status. */
  collector: string;
  /** Channel id, username or handle as configured; the `account` column of social_post_stats. */
  account: string;
  /** The metric_samples prefix. */
  key: string;
  label: string;
  staleHours: number;
  /** The follower or subscriber metric the report and totals use. */
  followersMetric: string;
  metrics: AccountMetric[];
}

export type SocialAccount =
  | (Base & { platform: 'youtube'; cfg: YouTubeCfg })
  | (Base & { platform: 'instagram'; cfg: InstagramCfg })
  | (Base & { platform: 'x'; cfg: XCfg })
  | (Base & { platform: 'linkedin'; cfg: LinkedInCfg });

/** Manual entries are weekly, so a LinkedIn reading is fresh for 8 days unless the account says otherwise. */
const LINKEDIN_STALE_HOURS = 192;

export function socialAccounts(s: Cfg): SocialAccount[] {
  const base = (platform: Platform, account: string, key: string, label: string | undefined, stale: number | undefined, extra: AccountMetric[], followers: 'followers' | 'subscribers') => ({
    collector: `${platform}:${key}`,
    account,
    key,
    label: label ?? `${platform} ${account}`,
    staleHours: stale ?? (platform === 'linkedin' ? LINKEDIN_STALE_HOURS : s.staleHours),
    followersMetric: `${key}.${followers}`,
    metrics: [{ metric: `${key}.${followers}`, unit: followers }, ...extra],
  });
  return [
    ...s.youtube.map((c): SocialAccount => {
      const key = c.key ?? `yt.${c.channelId.toLowerCase()}`;
      return { platform: 'youtube', cfg: c, ...base('youtube', c.channelId, key, c.label, c.staleHours,
        [{ metric: `${key}.views`, unit: 'count' }, { metric: `${key}.videos`, unit: 'count' }], 'subscribers') };
    }),
    ...s.instagram.map((c): SocialAccount => {
      const key = c.key ?? `ig.${c.username.toLowerCase()}`;
      return { platform: 'instagram', cfg: c, ...base('instagram', c.username.toLowerCase(), key, c.label, c.staleHours,
        [{ metric: `${key}.posts`, unit: 'count' }], 'followers') };
    }),
    ...s.x.map((c): SocialAccount => {
      const key = c.key ?? `x.${c.handle.toLowerCase()}`;
      return { platform: 'x', cfg: c, ...base('x', c.handle.toLowerCase(), key, c.label, c.staleHours, [], 'followers') };
    }),
    ...s.linkedin.map((c): SocialAccount => {
      const key = c.key ?? `li.${c.account}`;
      return { platform: 'linkedin', cfg: c, ...base('linkedin', c.account, key, c.label, c.staleHours, [], 'followers') };
    }),
  ];
}

/** Every metric key an API collector writes; the page scrapers in collect.ts skip these so no key gets two sources. */
export function socialMetricKeys(s: Cfg): Set<string> {
  const keys = new Set<string>();
  for (const a of socialAccounts(s)) {
    if (a.platform === 'linkedin') continue;
    if (a.platform === 'x' && !a.cfg.followers) continue;
    for (const m of a.metrics) keys.add(m.metric);
  }
  return keys;
}
