import type { SocialMetricsSettings } from '../../settings.js';
import type { SocialAccount } from './accounts.js';
import { count, getJson, redact } from './http.js';
import { hasToken, loadToken, recordTokenError, saveToken } from './tokens.js';
import { emptyResult, type PostStat, type SocialDeps, type SocialResult } from './types.js';

/**
 * Instagram API with Instagram Login, for a Professional (Business or Creator)
 * account the owner manages. Standard Access, no App Review. Scopes:
 * instagram_business_basic (profile, media) and
 * instagram_business_manage_insights (per-post insights).
 *
 * Tokens: a long-lived token lasts 60 days and can be refreshed once it is 24
 * hours old. The collector refreshes it about weekly (and daily in its last 14
 * days) and stores the new one encrypted; a failed refresh is recorded and
 * collection carries on with the current token until it expires.
 */

export const INSTAGRAM_SOURCE = 'instagram-graph';
const HOST = 'https://graph.instagram.com';
const DAY = 86_400_000;

type InstagramAccount = Extract<SocialAccount, { platform: 'instagram' }>;

interface Me { user_id?: string; username?: string; followers_count?: number; media_count?: number }
interface Media {
  id: string; media_type?: string; media_product_type?: string; permalink?: string; timestamp?: string;
  like_count?: number; comments_count?: number;
}
interface Insight { name: string; values?: { value?: number }[]; total_value?: { value?: number } }

const INSIGHT_METRICS = 'views,reach,likes,comments,shares,saved';

function recovery(username: string): string {
  return `generate a new long-lived token for @${username} (Instagram API with Instagram Login; scopes instagram_business_basic, instagram_business_manage_insights) and pipe it to \`secondbrain metrics social token instagram ${username}\` (docs/social-metrics.md)`;
}

/** The token to use now, refreshing and storing it when due. Throws an actionable error when there is none. */
async function resolveToken(a: InstagramAccount, deps: SocialDeps, r: SocialResult): Promise<string> {
  const username = a.account;
  const envName = a.cfg.tokenEnv;
  const envToken = envName ? deps.env[envName] || undefined : undefined;
  const missing = () => new Error(`no Instagram token for @${username}: ${envName ? `set ${envName} in the env file, or ` : ''}${recovery(username)}`);

  if (!deps.encKey) {
    if (!envToken) {
      if (await hasToken('instagram', username)) throw new Error('SOCIAL_TOKEN_ENC_KEY is not set, so the stored Instagram token cannot be read; set it to the key the token was stored with');
      throw missing();
    }
    r.warnings.push(`SOCIAL_TOKEN_ENC_KEY is not set: using ${envName} as is; refreshed tokens cannot be stored, so it stops working 60 days after it was issued`);
    return envToken;
  }

  let stored = await loadToken('instagram', username, deps.encKey);
  if (!stored) {
    if (!envToken) throw missing();
    if (deps.readOnly) return envToken;
    // Seeded from env once; from then on the store wins (it holds the refreshed token).
    await saveToken('instagram', username, envToken, deps.encKey, { expiresAt: null, refreshedAt: deps.now });
    stored = await loadToken('instagram', username, deps.encKey);
  }
  const t = stored!;
  const now = deps.now.getTime();
  if (t.expiresAt && t.expiresAt.getTime() <= now) {
    throw new Error(`the stored Instagram token for @${username} expired on ${t.expiresAt.toISOString().slice(0, 10)}: ${recovery(username)}`);
  }
  const age = now - t.refreshedAt.getTime();
  const due = t.expiresAt === null || age >= 7 * DAY || (t.expiresAt.getTime() - now <= 14 * DAY && age >= DAY);
  if (!due || deps.readOnly) return t.token;
  try {
    const j = await getJson<{ access_token?: string; expires_in?: number }>(deps.get,
      `${HOST}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(t.token)}`, 'refresh', [t.token]);
    if (!j.access_token || typeof j.expires_in !== 'number') throw new Error('refresh: no token in the answer');
    await saveToken('instagram', username, j.access_token, deps.encKey, { expiresAt: new Date(now + j.expires_in * 1000), refreshedAt: deps.now });
    return j.access_token;
  } catch (err) {
    const msg = redact(`Instagram token refresh failed: ${(err as Error).message}${t.expiresAt ? `; the current token expires ${t.expiresAt.toISOString().slice(0, 10)}` : ''}`, [t.token]);
    await recordTokenError('instagram', username, msg);
    r.warnings.push(msg);
    return t.token;
  }
}

export async function collectInstagram(a: InstagramAccount, s: SocialMetricsSettings, deps: SocialDeps): Promise<SocialResult> {
  const r = emptyResult(a);
  let token: string | undefined;
  try {
    token = await resolveToken(a, deps, r);
    const tok = token;
    const base = `${HOST}/${s.instagramApiVersion}`;
    const call = <T>(url: string, what: string) => getJson<T>(deps.get, url, what, [tok]);
    const auth = `access_token=${encodeURIComponent(tok)}`;

    const me = await call<Me>(`${base}/me?fields=user_id,username,followers_count,media_count&${auth}`, 'Instagram /me');
    const actual = (me.username ?? '').toLowerCase();
    if (actual !== a.account) {
      // Never file one account's numbers under another's key.
      throw new Error(`the Instagram token belongs to @${actual || '?'}, not @${a.account}; nothing written. Fix username in socialMetrics.instagram (a new handle gets a new metric key, so the old account's history stays as it was) or store the right account's token`);
    }
    const followers = count(me.followers_count);
    if (followers !== null) r.samples.push({ metric: `${a.key}.followers`, unit: 'followers', value: followers, source: INSTAGRAM_SOURCE, raw: { user_id: me.user_id ?? null } });
    const media = count(me.media_count);
    if (media !== null) r.samples.push({ metric: `${a.key}.posts`, unit: 'count', value: media, source: INSTAGRAM_SOURCE });
    if (!a.cfg.posts) return r;

    const cutoff = deps.now.getTime() - s.postDays * DAY;
    const items: Media[] = [];
    let url: string | undefined = `${base}/me/media?fields=id,media_type,media_product_type,permalink,timestamp,like_count,comments_count&limit=50&${auth}`;
    paging: while (url) {
      const page: { data?: Media[]; paging?: { next?: string } } = await call(url, 'Instagram /me/media');
      for (const m of page.data ?? []) {
        if ((m.timestamp && Date.parse(m.timestamp) <= cutoff) || items.length >= s.maxPosts) break paging;
        items.push(m);
      }
      url = page.paging?.next;
    }

    let failed = 0;
    let firstFailure = '';
    for (const m of items) {
      let ins: Map<string, number | null> | null = null;
      try {
        const j = await call<{ data?: Insight[] }>(`${base}/${m.id}/insights?metric=${INSIGHT_METRICS}&${auth}`, 'Instagram insights');
        ins = new Map((j.data ?? []).map((d) => [d.name, count(d.total_value?.value ?? d.values?.[0]?.value)]));
      } catch (err) {
        failed++;
        firstFailure ||= (err as Error).message;
      }
      r.posts.push(mediaStat(a, m, ins));
    }
    if (failed) {
      const msg = `insights failed for ${failed} of ${items.length} posts (first: ${firstFailure}); their views, reach, shares and saves are left empty`;
      if (failed === items.length) r.error = `${msg}. Does the token have instagram_business_manage_insights?`;
      else r.warnings.push(msg);
    }
  } catch (err) {
    r.error = redact((err as Error).message, [token]);
  }
  return r;
}

/**
 * Stores a long-lived token the owner generated, after checking with /me that
 * it belongs to the configured account. Replaces any stored token (recovery
 * after expiry, or a new account). The token is never echoed back.
 */
export async function seedInstagramToken(s: SocialMetricsSettings, username: string, token: string, deps: SocialDeps): Promise<{ username: string; followers: number | null }> {
  const a = s.instagram.find((c) => c.username.toLowerCase() === username.toLowerCase());
  if (!a) throw new Error(`@${username} is not in socialMetrics.instagram in secondbrain.json; add it first`);
  if (!deps.encKey) throw new Error('SOCIAL_TOKEN_ENC_KEY is not set: tokens are stored encrypted. Generate one with `node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"` and add it to the env file');
  const t = token.trim();
  if (!t || /\s/.test(t)) throw new Error('expected one token on stdin');
  try {
    const me = await getJson<Me>(deps.get, `${HOST}/${s.instagramApiVersion}/me?fields=username,followers_count&access_token=${encodeURIComponent(t)}`, 'Instagram /me', [t]);
    const actual = (me.username ?? '').toLowerCase();
    if (actual !== a.username.toLowerCase()) throw new Error(`this token belongs to @${actual || '?'}, not @${a.username.toLowerCase()}; not stored`);
    await saveToken('instagram', actual, t, deps.encKey, { expiresAt: null, refreshedAt: deps.now });
    return { username: actual, followers: count(me.followers_count) };
  } catch (err) {
    throw new Error(redact((err as Error).message, [t]));
  }
}

function kindOf(m: Media): string | null {
  if (m.media_product_type === 'REELS') return 'reel';
  if (m.media_product_type === 'STORY') return 'story';
  switch (m.media_type) {
    case 'IMAGE': return 'image';
    case 'VIDEO': return 'video';
    case 'CAROUSEL_ALBUM': return 'carousel';
    default: return null;
  }
}

function mediaStat(a: InstagramAccount, m: Media, ins: Map<string, number | null> | null): PostStat {
  const pick = (name: string) => ins?.get(name) ?? null;
  return {
    platform: 'instagram', account: a.account, externalId: m.id, url: m.permalink ?? null,
    postedAt: m.timestamp ? new Date(m.timestamp) : null, kind: kindOf(m),
    views: pick('views'), reach: pick('reach'), shares: pick('shares'), saves: pick('saved'),
    likes: pick('likes') ?? count(m.like_count), comments: pick('comments') ?? count(m.comments_count),
    source: INSTAGRAM_SOURCE, raw: { media_type: m.media_type ?? null, media_product_type: m.media_product_type ?? null, insights: ins ? Object.fromEntries(ins) : null },
  };
}
