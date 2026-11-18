import { fileURLToPath } from 'node:url';
import { superviseSelf } from './usage/supervise.js';

const code = await superviseSelf(fileURLToPath(import.meta.url), 600000, true);
if (code !== null) process.exit(code);
await import('./cli-agents-sync-worker.js');
