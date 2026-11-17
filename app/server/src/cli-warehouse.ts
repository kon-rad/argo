import { exitFlushed } from './cli-exit.js';
import { config } from './config.js';
import { pool } from './db.js';
import { connectorViews, dataPaths, listTables, overview } from './addons/warehouse/catalog.js';
import { loadConnectors } from './addons/warehouse/connectors.js';
import { migrate } from './addons/warehouse/migrate.js';
import { runConnector, runDue } from './addons/warehouse/runner.js';

/**
 * secondbrain warehouse migrate [--dry-run]
 * secondbrain warehouse run <connector> [-- args...]   one connector now (e.g. -- --backfill)
 * secondbrain warehouse run --due                       every connector whose schedule is due (the timer)
 * secondbrain warehouse status                          connectors, last runs, sizes
 * secondbrain warehouse tables                          every table with rows and size
 * Exit 0 ok, 1 error, 2 a connector failed (partial).
 */
const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;
const paths = dataPaths();
const human = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} kB`);

async function main(): Promise<number> {
  switch (cmd) {
    case 'migrate': {
      const r = await migrate(paths.migrations, { dryRun: rest.includes('--dry-run') });
      if (rest.includes('--dry-run')) console.log(r.pending.length ? `pending: ${r.pending.join(', ')}` : 'nothing pending');
      else console.log(r.applied.length ? `applied: ${r.applied.join(', ')}` : 'nothing to apply');
      return 0;
    }
    case 'run': {
      if (rest[0] === '--due') {
        const results = await runDue(paths.dir, { rawRoot: paths.rawRoot });
        for (const r of results) console.log(`${r.connector}: ${r.status} ${JSON.stringify(r.rows)}${r.error ? ` - ${r.error}` : ''}`);
        if (!results.length) console.log('no connector is due');
        return results.some((r) => r.status === 'failed') ? 2 : 0;
      }
      const name = rest[0];
      if (!name) throw new Error('usage: secondbrain warehouse run <connector> [-- args] | --due');
      const { defs, errors } = loadConnectors(paths.dir);
      const def = defs.find((d) => d.name === name);
      if (!def) {
        const broken = errors.find((e) => e.name === name);
        throw new Error(broken ? `${name}: ${broken.error}` : `no connector "${name}" in ${paths.dir}/connectors`);
      }
      const dd = rest.indexOf('--');
      const r = await runConnector(def, { rawRoot: paths.rawRoot, args: dd >= 0 ? rest.slice(dd + 1) : [] });
      console.log(`${r.connector} run ${r.runId}: ${r.status} ${JSON.stringify(r.rows)}${r.error ? `\n${r.error}` : ''}`);
      return r.status === 'ok' ? 0 : 2;
    }
    case 'status': {
      const { defs, errors } = loadConnectors(paths.dir);
      const o = await overview(defs, errors);
      console.log(`database ${human(o.dbBytes)}; schema data ${human(o.dataBytes)} in ${o.dataTables} tables; data dir ${paths.dir}`);
      for (const v of await connectorViews(defs)) {
        const last = v.lastRuns[0];
        console.log(`${v.name}: ${v.enabled ? (v.schedule ? `every ${v.schedule.every}${v.schedule.at ? ` at ${v.schedule.at} UTC` : ''}` : 'manual') : 'disabled'}; last ${last ? `${last.status} ${last.startedAt} ${JSON.stringify(last.rows)}${last.error ? ` - ${last.error.split('\n')[0]}` : ''}` : 'never'}${v.missingEnv.length ? `; missing env ${v.missingEnv.join(', ')}` : ''}`);
      }
      for (const e of errors) console.log(`${e.name}: BROKEN - ${e.error}`);
      return 0;
    }
    case 'tables': {
      const { defs } = loadConnectors(paths.dir);
      for (const t of await listTables(defs, config.modules)) {
        if (!rest.includes('--all') && t.schema !== 'data') continue;
        console.log(`${t.schema}.${t.name}\t${t.rowsEstimated ? '~' : ''}${t.rows} rows\t${human(t.bytes)}${t.owner ? `\t${t.owner}` : ''}`);
      }
      return 0;
    }
    default:
      console.error('usage: secondbrain warehouse migrate [--dry-run] | run <connector> [-- args] | run --due | status | tables [--all]');
      return cmd ? 1 : 0;
  }
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error((err as Error).message);
  code = 1;
} finally {
  await pool.end().catch(() => {});
}
await exitFlushed(code);
