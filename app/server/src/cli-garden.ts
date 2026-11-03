import { exitFlushed } from './cli-exit.js';
import { config } from './config.js';
import { pool } from './db.js';
import { runGarden } from './garden/run.js';
import { settings } from './settings.js';

/**
 * secondbrain garden [--write] [--apply] [--today YYYY-MM-DD] [--no-wiki] [--no-db]
 * Shadow by default: plans the night and writes only the report. --write also
 * writes the shelf notes and the catalog; --apply (or garden.apply in
 * secondbrain.json) also moves and renames with git mv. Runs on the checkout;
 * the database is only asked for tracker stages.
 */
const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const ti = argv.indexOf('--today');
const garden = settings().garden;
const mode = flag('--apply') || garden.apply ? 'apply' : flag('--write') ? 'write' : 'shadow';
const useDb = !flag('--no-db');

let code = 1;
try {
  const stages = new Map<string, string | null>();
  if (useDb) {
    try {
      const r = await pool.query<{ slug: string; stage: string }>('SELECT slug, stage FROM projects');
      for (const row of r.rows) stages.set(row.slug, row.stage);
    } catch (err) {
      console.error(`tracker unreachable, treating every project stage as unknown: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  const r = await runGarden(config.vaultRoot, {
    mode,
    settings: garden,
    today: ti >= 0 ? argv[ti + 1] : undefined,
    trackerStage: (slug) => stages.get(slug) ?? null,
    skipWiki: flag('--no-wiki'),
  });
  const n = (t: string) => r.actions.filter((a) => a.type === t).length;
  console.log(
    `garden ${r.mode}: ${r.shelves} shelves, ${r.created} notes created, ` +
    `${n('archive')} archive ${r.mode === 'apply' ? 'moves' : 'candidates'}, ${n('propose-archive')} proposals, ${n('rename')} renames, ${n('report')} for a human` +
    (r.applied ? `; applied ${r.applied.done.length}, refused ${r.applied.refused.length}, links rewritten ${r.applied.linksRewritten}` : '') +
    `; report ${r.reportPath}`,
  );
  code = r.applied && r.applied.refused.length > 0 ? 2 : 0;
} catch (err) {
  console.error(`garden failed: ${(err as Error).message}`);
} finally {
  if (useDb) await pool.end();
}
await exitFlushed(code);
