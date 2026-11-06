import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
export default {
  resolve: { alias: { '@secondbrain/desk-contracts/desk': resolve(here, '../../app/shared/desk/index.ts') } },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
};
