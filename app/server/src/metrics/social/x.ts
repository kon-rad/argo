import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { SocialMetricsSettings } from '../../settings.js';
import { parseFxTwitter } from '../collect.js';
import type { SocialAccount } from './accounts.js';
import { count, getJson } from './http.js';
import { emptyResult, type PostStat, type SocialDeps, type SocialResult } from './types.js';

/**
 * X through fxtwitter (api.fxtwitter.com): public, no key, unofficial, and it
 * can break without notice. It answers a profile (followers) and a single
 * post by id. It has no timeline, so this collector never discovers posts: it
 * reads only ids it is given, from posts the social module published
 * (social_posts.remote_url) and from the account's `postIdsFile`.
 */

export const FXTWITTER_SOURCE = 'fxtwitter';
const API = 'https://api.fxtwitter.com';
const X_EPOCH = 1288834974657n;

type XAccount = Extract<SocialAccount, { platform: 'x' }>;

/** A post id (snowflake) carries its creation time; ids from before snowflakes give null. */
export function snowflakeTime(id: string): Date | null {
  if (!/^\d{15,20}$/.test(id)) return null;
  const ms = (BigInt(id) >> 22n) + X_EPOCH;
  return new Date(Number(ms));
}

/** A status id from an id or an x.com / twitter.com URL, and the handle in the URL when there is one. */
export function parseStatusRef(text: string): { id: string; handle: string | null } | null {
  const t = text.trim();
  if (/^\d{5,20}$/.test(t)) return { id: t, handle: null };
  const m = /(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status(?:es)?\/(\d{5,20})/.exec(t);
  if (!m) return null;
  return { id: m[2]!, handle: m[1] === 'i' ? null : m[1]!.toLowerCase() };
}

/** Ids from the account's postIdsFile; bad lines come back as warnings. A missing file is a warning, not a failure. */
export function readPostIdsFile(vaultRoot: string, file: string): { refs: { id: string; handle: string | null }[]; warnings: string[] } {
  const path = isAbsolute(file) ? file : join(vaultRoot, file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { refs: [], warnings: [`postIdsFile ${file} not found`] };
  }
  const refs: { id: string; handle: string | null }[] = [];
  const bad: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const ref = parseStatusRef(line);
    if (ref) refs.push(ref);
    else bad.push(line.slice(0, 80));
  }
  return { refs, warnings: bad.length ? [`postIdsFile ${file}: not a post id or URL: ${bad.join(', ')}`] : [] };
}

interface FxTweet {
  id?: string; url?: string; created_timestamp?: number;
  views?: number | null; likes?: number; replies?: number; retweets?: number; quotes?: number; bookmarks?: number;
  author?: { screen_name?: string };
}

/** `known`: post URLs the social module recorded for X. */
export async function collectX(a: XAccount, s: SocialMetricsSettings, deps: SocialDeps, known: string[]): Promise<SocialResult> {
  const r = emptyResult(a);
  const get = deps.publicGet ?? deps.get;
  try {
    if (a.cfg.followers) {
      const res = await get(`${API}/${a.cfg.handle}`);
      if (res.status !== 200) throw new Error(`fxtwitter: HTTP ${res.status}`);
      r.samples.push({ metric: `${a.key}.followers`, unit: 'followers', value: parseFxTwitter(res.body), source: FXTWITTER_SOURCE });
    }
    if (!a.cfg.posts) return r;

    const refs = known.map(parseStatusRef).filter((x): x is { id: string; handle: string | null } => x !== null);
    if (a.cfg.postIdsFile) {
      const f = readPostIdsFile(deps.vaultRoot, a.cfg.postIdsFile);
      refs.push(...f.refs);
      r.warnings.push(...f.warnings);
    }
    const cutoff = deps.now.getTime() - s.postDays * 86_400_000;
    const ids = [...new Map(refs
      // A URL naming another handle belongs to another account.
      .filter((ref) => ref.handle === null || ref.handle === a.account)
      .filter((ref) => { const t = snowflakeTime(ref.id); return t === null || t.getTime() > cutoff; })
      .map((ref) => [ref.id, ref])).keys()].slice(0, s.maxPosts);

    let failed = 0;
    let firstFailure = '';
    const foreign: string[] = [];
    for (const id of ids) {
      try {
        const j = await getJson<{ code?: number; tweet?: FxTweet }>(get, `${API}/status/${id}`, `fxtwitter status ${id}`, []);
        const tw = j.tweet;
        if (!tw) throw new Error(`fxtwitter status ${id}: no post (code ${j.code ?? '?'})`);
        const author = (tw.author?.screen_name ?? '').toLowerCase();
        if (author !== a.account) { foreign.push(`${id} is by @${author || '?'}`); continue; }
        r.posts.push(tweetStat(a, id, tw));
      } catch (err) {
        failed++;
        firstFailure ||= (err as Error).message;
      }
    }
    if (foreign.length) r.warnings.push(`skipped posts by other accounts: ${foreign.join(', ')}`);
    if (failed) {
      const msg = `fxtwitter failed for ${failed} of ${ids.length} posts (first: ${firstFailure})`;
      if (failed === ids.length) r.error = msg;
      else r.warnings.push(msg);
    }
  } catch (err) {
    r.error = (err as Error).message;
  }
  return r;
}

function tweetStat(a: XAccount, id: string, tw: FxTweet): PostStat {
  return {
    platform: 'x', account: a.account, externalId: id,
    url: tw.url ?? `https://x.com/${a.cfg.handle}/status/${id}`,
    postedAt: typeof tw.created_timestamp === 'number' ? new Date(tw.created_timestamp * 1000) : snowflakeTime(id),
    kind: 'post',
    // fxtwitter gives views as null when X hides them: kept null.
    views: count(tw.views), likes: count(tw.likes), comments: count(tw.replies), shares: count(tw.retweets),
    saves: count(tw.bookmarks), reach: null,
    source: FXTWITTER_SOURCE, raw: { quotes: tw.quotes ?? null },
  };
}
