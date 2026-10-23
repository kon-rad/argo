import { config } from './config.js';
import { pool } from './db.js';
import { collectAll, collectors, insertSample, metricViews } from './metrics/collect.js';
import { collectPostStats, postSources } from './metrics/posts.js';
import { metrics } from './metrics/registry.js';

// `cli-metrics collect [--dry-run]`  fetch every public source once, write one row each (daily timer)
// `cli-metrics set <metric> <value>`  a manual reading (Instagram when its page is walled)
// `cli-metrics list`                 latest value and age of every metric
const [cmd, ...args] = process.argv.slice(2);
let code = 1;
try {
  if (cmd === 'collect') {
    const dry = args.includes('--dry-run');
    const res = await collectAll(collectors(config.vaultRoot), !dry);
    for (const r of res) console.log(`${r.metric}\t${r.error ? `FAILED: ${r.error}` : r.value}`);
    // Per-post stats (social_post_stats): networks without a key or account are skipped, not failed.
    const { sources, skipped } = postSources();
    const posts = await collectPostStats(sources, { write: !dry });
    for (const s of skipped) console.log(`posts:${s.source}\tskipped: ${s.skipped}`);
    for (const r of posts) console.log(`posts:${r.source}\t${r.error ? `FAILED: ${r.error}` : `${r.rows} posts`}`);
    // Exit 2 = some sources failed (the rest were written); not a unit failure.
    code = res.some((r) => r.error) || posts.some((r) => r.error) ? 2 : 0;
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
  } else {
    console.error(`usage: cli-metrics collect [--dry-run] | set <metric> <value> | list\nmetrics: ${metrics().map((m) => m.key).join(', ') || 'none (add them to secondbrain.json)'}`);
  }
} catch (err) {
  console.error((err as Error).message);
} finally {
  await pool.end();
}
process.exit(code);
