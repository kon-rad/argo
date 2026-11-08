import type { SocialMetricsSettings } from '../../settings.js';
import { socialAccounts, type Platform, type SocialAccount } from './accounts.js';
import { redact } from './http.js';
import { collectInstagram } from './instagram.js';
import { insertAccountSamples, publishedPosts, publishedUrls, recordStatus, upsertPostStats, utcDay } from './store.js';
import type { SocialDeps, SocialResult } from './types.js';
import { collectX } from './x.js';
import { collectYouTube } from './youtube.js';

/**
 * Runs every configured social collector once (the daily metrics timer). Each
 * account is isolated: a missing credential or an API failure is that
 * account's error, recorded in social_metric_status, and every other account
 * still runs. Nothing is deleted, so the last good reading stays in place.
 * LinkedIn accounts are manual only and are skipped here.
 */
export async function collectSocial(s: SocialMetricsSettings, deps: SocialDeps, write = true): Promise<SocialResult[]> {
  const accounts = socialAccounts(s);
  const of = <P extends Platform>(p: P) => accounts.filter((a): a is Extract<SocialAccount, { platform: P }> => a.platform === p);
  const secrets = [deps.youtubeApiKey, deps.encKey];
  const results: SocialResult[] = [];

  results.push(...await collectYouTube(of('youtube'), s, deps));
  for (const a of of('instagram')) results.push(await collectInstagram(a, s, deps));
  const xAccounts = of('x');
  const xUrls = xAccounts.some((a) => a.cfg.posts) ? await publishedUrls('x') : [];
  for (const a of xAccounts) results.push(await collectX(a, s, deps, xUrls));

  for (const r of results) {
    if (r.error) r.error = redact(r.error, secrets);
    r.warnings = r.warnings.map((w) => redact(w, secrets));
  }
  if (!write) return results;

  const day = utcDay(deps.now);
  const matches = new Map<Platform, Map<string, number>>();
  for (const r of results) {
    try {
      await insertAccountSamples(r.samples, deps.now);
      if (r.posts.length) {
        if (!matches.has(r.platform)) matches.set(r.platform, await publishedPosts(r.platform));
        await upsertPostStats(r.posts, day, deps.now, matches.get(r.platform));
      }
    } catch (err) {
      r.error = `storing: ${(err as Error).message}`;
    }
    await recordStatus(r, deps.now);
  }
  return results;
}

/** One line per account for the timer's journal: never a token, only counts and redacted errors. */
export function describeResult(r: SocialResult): string[] {
  const head = `${r.collector}\t${r.error ? `FAILED: ${r.error}` : 'ok'}`;
  const parts = r.samples.map((x) => `${x.metric.slice(r.key.length + 1)}=${x.value}`);
  if (r.posts.length) parts.push(`posts=${r.posts.length}`);
  return [`${head}${parts.length ? `\t${parts.join(' ')}` : ''}`, ...r.warnings.map((w) => `${r.collector}\twarning: ${w}`)];
}
