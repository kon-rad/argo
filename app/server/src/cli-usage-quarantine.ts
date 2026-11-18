import { fileURLToPath } from 'node:url';
import { superviseSelf } from './usage/supervise.js';

const code = await superviseSelf(fileURLToPath(import.meta.url), 120_000);
if (code !== null) process.exit(code);
await import('./cli-usage-quarantine-worker.js');
