import { config } from './config.js';
import { pool } from './db.js';
import { buildMap } from './map/build.js';

// `secondbrain map-build`: rebuild the brain map's stored layout (map_* tables)
// from vault_files, vault_links, the tracker and goals-master.md. Droplet only,
// like scan and embed: the Mac is a client of the master database.
let code = 1;
try {
  if (!config.indexer && !process.argv.includes('--force')) {
    console.error('map-build runs where the indexer runs (the droplet); this process is a client. --force to override.');
    code = 3;
  } else {
    const r = await buildMap(config.vaultRoot);
    console.log(`map layout v${r.version}: ${r.nodes} nodes, ${r.edges} edges, built in ${r.ms} ms`);
    code = 0;
  }
} catch (err) {
  console.error(`map-build failed: ${(err as Error).message}`);
} finally {
  await pool.end();
}
process.exit(code);
