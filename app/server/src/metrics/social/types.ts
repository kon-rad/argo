import type { HttpGet } from '../collect.js';
import type { AccountMetric, Platform } from './accounts.js';

export interface AccountSample extends AccountMetric { value: number; source: string; raw?: unknown }

/** One post's numbers as read today. A null metric means the platform did not say. */
export interface PostStat {
  platform: Platform;
  account: string;
  externalId: string;
  url: string | null;
  postedAt: Date | null;
  kind: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
  source: string;
  raw?: unknown;
}

/** What one account's collector produced. An error with samples or posts is a partial run: what was read is kept. */
export interface SocialResult {
  collector: string;
  platform: Platform;
  account: string;
  key: string;
  samples: AccountSample[];
  posts: PostStat[];
  warnings: string[];
  error?: string;
}

export interface SocialDeps {
  /** For calls carrying a key or token (Node fetch; see http.ts). */
  get: HttpGet;
  /** For public, keyless endpoints (fxtwitter); defaults to `get`. */
  publicGet?: HttpGet;
  now: Date;
  youtubeApiKey?: string;
  /** SOCIAL_TOKEN_ENC_KEY: encrypts stored tokens. */
  encKey?: string;
  /** Where `tokenEnv` names are looked up. */
  env: Record<string, string | undefined>;
  vaultRoot: string;
}

export function emptyResult(a: { collector: string; platform: Platform; account: string; key: string }): SocialResult {
  return { collector: a.collector, platform: a.platform, account: a.account, key: a.key, samples: [], posts: [], warnings: [] };
}
