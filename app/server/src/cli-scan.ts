import { config } from './config.js';
import { pool, query } from './db.js';
import { scanVault } from './connectors/vault/scan.js';

/**
 * secondbrain scan, when no server is running (the launcher goes through
 * POST /api/sources/:id/sync when one is, so the server's queue keeps one
 * scanner at a time). Scans the vault source once and prints the counts.
 * Also `npm run scan` in server/.
 */
const { rows } = await query<{ id: number; config: { root?: string; skip_dirs?: string[] } }>(
  'SELECT id, config FROM sources WHERE kind = $1 ORDER BY id LIMIT 1',
  ['vault'],
);
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
console.log(JSON.stringify({
  scanned: stats.scanned,
  inserted: stats.inserted,
  updated: stats.updated,
  deleted: stats.deleted,
}));
await pool.end();
