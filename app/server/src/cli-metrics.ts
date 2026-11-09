import { exitFlushed } from './cli-exit.js';
import { config } from './config.js';
import { pool } from './db.js';
import { collectAll, collectors, curlGet, curlRpc, insertSample, metricViews } from './metrics/collect.js';
import { metrics } from './metrics/registry.js';
import { socialMetricKeys } from './metrics/social/accounts.js';
import { collectSocial, describeResult } from './metrics/social/collect.js';
import { fetchGet } from './metrics/social/http.js';
import { seedInstagramToken } from './metrics/social/instagram.js';
import { recordLinkedIn } from './metrics/social/manual.js';
import { formatSocialReport, socialReport } from './metrics/social/report.js';
import type { SocialDeps } from './metrics/social/types.js';
import { settings } from './settings.js';

// `cli-metrics collect [--dry-run]`  fetch every source once, write one row each (daily timer):
//                                    the page collectors in `metrics[]`, then the social API collectors in `socialMetrics`
// `cli-metrics set <metric> <value>`  a manual reading
// `cli-metrics list`                 latest value and age of every metric
// `cli-metrics social [--days N] [--top N] [--json]`  follower deltas and top posts, with freshness
// `cli-metrics social linkedin <account> [--followers N] [--post URL [--views N] [--likes N] [--comments N] [--shares N] [--reach N]] [--date YYYY-MM-DD]`
// `cli-metrics social token instagram <username>`     store a long-lived token read from stdin (encrypted)
const USAGE = `usage: cli-metrics collect [--dry-run] | set <metric> <value> | list
       cli-metrics social [--days N] [--top N] [--json]
       cli-metrics social linkedin <account> [--followers N] [--post URL [--views N] [--likes N] [--comments N] [--shares N] [--reach N]] [--date YYYY-MM-DD]
       cli-metrics social token instagram <username>   (token on stdin)`;

const [cmd, ...args] = process.argv.slice(2);
let code = 1;

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
  return v;
}
function intFlag(name: string): number | undefined {
  const v = flag(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a whole number`);
  return n;
}
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('pipe the token on stdin (it is never taken as an argument, so it stays out of shell history)');
  const parts: Buffer[] = [];
  for await (const c of process.stdin) parts.push(c as Buffer);
  return Buffer.concat(parts).toString('utf8');
}
const socialDeps = (): SocialDeps => ({
  get: fetchGet, publicGet: curlGet, now: new Date(), youtubeApiKey: config.youtubeApiKey,
  encKey: config.socialTokenEncKey, env: process.env, vaultRoot: config.vaultRoot,
});

try {
  const social = settings().socialMetrics;
  if (cmd === 'collect') {
    const dry = args.includes('--dry-run');
    // A metric an API collector writes is not also scraped from its page.
    const apiKeys = socialMetricKeys(social);
    const pages = metrics().filter((m) => !apiKeys.has(m.key));
    for (const m of metrics()) if (m.collect && apiKeys.has(m.key)) console.log(`${m.key}\tread by the socialMetrics API collector, page collector skipped`);
    const res = await collectAll(collectors(config.vaultRoot, curlGet, curlRpc, pages), !dry);
    for (const r of res) console.log(`${r.metric}\t${r.error ? `FAILED: ${r.error}` : r.value}`);
    const socialRes = await collectSocial(social, socialDeps(), !dry);
    for (const r of socialRes) for (const line of describeResult(r)) console.log(line);
    // Exit 2 = some sources failed (the rest were written); not a unit failure.
    code = res.some((r) => r.error) || socialRes.some((r) => r.error) ? 2 : 0;
  } else if (cmd === 'set') {
    const [metric, raw] = args;
    const value = Number(raw);
    if (!metric || !Number.isFinite(value)) throw new Error('usage: set <metric> <value>');
    await insertSample({ metric, source: 'manual', value });
    console.log(`recorded ${metric} = ${value}`);
    code = 0;
  } else if (cmd === 'list') {
    for (const m of await metricViews()) {
      const v = m.value === null ? 'no data' : `${m.value}${m.currency ? ` ${m.currency}` : ''}`;
      console.log(`${m.key}\t${v}\t${m.sampledAt ?? ''}\t${m.source ?? ''}`);
    }
    code = 0;
  } else if (cmd === 'social' && args[0] === 'linkedin') {
    const account = args[1];
    if (!account || account.startsWith('--')) throw new Error(USAGE);
    const url = flag('post');
    await recordLinkedIn(social, account, {
      followers: intFlag('followers'),
      date: flag('date'),
      post: url ? { url, views: intFlag('views'), likes: intFlag('likes'), comments: intFlag('comments'), shares: intFlag('shares'), reach: intFlag('reach') } : undefined,
    });
    console.log(`recorded LinkedIn ${account}${flag('date') ? ` for ${flag('date')}` : ''}`);
    code = 0;
  } else if (cmd === 'social' && args[0] === 'token') {
    if (args[1] !== 'instagram' || !args[2]) throw new Error(USAGE);
    const r = await seedInstagramToken(social, args[2], await readStdin(), socialDeps());
    console.log(`stored an encrypted token for @${r.username} (followers ${r.followers ?? 'unknown'}); it is refreshed by the metrics timer`);
    code = 0;
  } else if (cmd === 'social') {
    const days = intFlag('days') ?? 7;
    if (days < 1) throw new Error('--days must be at least 1');
    const report = await socialReport(social, { days, top: intFlag('top') ?? 10 });
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatSocialReport(report));
    code = 0;
  } else {
    console.error(`${USAGE}\nmetrics: ${metrics().map((m) => m.key).join(', ') || 'none (add them to secondbrain.json)'}`);
  }
} catch (err) {
  console.error((err as Error).message);
} finally {
  await pool.end();
}
await exitFlushed(code);
