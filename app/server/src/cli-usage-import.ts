import { exitFlushed } from './cli-exit.js';
import { createInterface } from 'node:readline';
import type { Host } from './archive/types.js';
import { pool } from './db.js';
import { importLines } from './usage/importer.js';

// Reads wire lines on stdin (from the Mac's usage-push over SSH) into this machine's ledger.
const host = (process.argv[2] ?? 'mac') as Host;
if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(host)) { console.error(`usage-import: bad host ${host}`); process.exit(1); }
let code = 1;
try {
  const c = await importLines(createInterface({ input: process.stdin, crlfDelay: Infinity }), host);
  console.log(`usage-import ${host}: ${c.lines} lines, ${c.calls} calls, ${c.sessions} sessions, ${c.messages} messages, ${c.plan} plan readings`);
  for (const e of c.errors.slice(0, 20)) console.error(`  ! ${e}`);
  code = c.errors.length ? 2 : 0;
} catch (err) {
  console.error(`usage-import failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await pool.end();
}
await exitFlushed(code);
