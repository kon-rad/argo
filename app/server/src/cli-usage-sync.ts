import { fileURLToPath } from 'node:url';
import { superviseSelf } from './usage/supervise.js';

const code = await superviseSelf(fileURLToPath(import.meta.url), 180000, true);
if (code !== null) process.exit(code);
await import('./cli-usage-sync-worker.js');
