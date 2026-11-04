import { config } from './config.js';
import { pool, query } from './db.js';
import { scanVault } from './connectors/vault/scan.js';

/**
 * secondbrain scan. With `--api <url>` and a running server, it goes through
 * POST /api/sources/:id/sync so the server's queue keeps one scanner at a time;
 * otherwise it scans the vault source directly and prints the counts. Also
 * `npm run scan` in server/.
 */
const argv = process.argv.slice(2);
const apiArg = argv.indexOf('--api');
const api = apiArg >= 0 ? argv[apiArg + 1] : undefined;

type Source = { id: number; kind: string; config: { root?: string; skip_dirs?: string[] } };

if (api) {
  const res = await fetch(`${api}/api/sources`, { signal: AbortSignal.timeout(5000) });
  const { sources } = (await res.json()) as { sources: Source[] };
  const vault = sources.find((s) => s.kind === 'vault');
  if (!vault) {
    console.error('no vault source');
    process.exit(1);
  }
  const sync = await fetch(`${api}/api/sources/${vault.id}/sync`, { method: 'POST', signal: AbortSignal.timeout(30000) });
  const j = (await sync.json()) as { run_id: number; status: string };
  console.log(`run ${j.run_id}: ${j.status}`);
} else {
  const { rows } = await query<Source>('SELECT id, config FROM sources WHERE kind = $1 ORDER BY id LIMIT 1', ['vault']);
  const source = rows[0];
  if (!source) {
    console.error('no vault source in the sources table: the migrations seed it, so run secondbrain start once');
    await pool.end();
    process.exit(1);
  }
  const stats = await scanVault({
    root: source.config.root ?? config.vaultRoot,
    sourceId: source.id,
    skipDirs: source.config.skip_dirs,
  });
  console.log(JSON.stringify({ scanned: stats.scanned, inserted: stats.inserted, updated: stats.updated, deleted: stats.deleted }));
  await pool.end();
}
