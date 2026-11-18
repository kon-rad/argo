import { readFileSync } from 'node:fs';
import { pool } from './db.js';
import { cleanupAttempts } from './usage/health.js';
import { inspectQuarantine, listQuarantine, replayQuarantine } from './usage/quarantine.js';

const [command, host = '', digest = '', file] = process.argv.slice(2);
try {
  if (command === 'cleanup') console.log(JSON.stringify({ removed: await cleanupAttempts() }));
  else {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(host)) throw new Error('invalid host');
    if (command === 'list') console.log(JSON.stringify(await listQuarantine(host)));
    else if (command === 'inspect') console.log(JSON.stringify(await inspectQuarantine(host, digest)));
    else if (command === 'replay') {
      const accepted = await replayQuarantine(host, digest, file ? readFileSync(file, 'utf8').trim() : undefined);
      console.log(JSON.stringify({ accepted }));
      process.exitCode = accepted ? 0 : 2;
    } else throw new Error('usage: usage-quarantine list <host> | inspect <host> <digest> | replay <host> <digest> [repaired-wire-file] | cleanup');
  }
} catch { console.error('quarantine operation failed; unaccepted records retained'); process.exitCode = 1; }
finally { await pool.end(); }
