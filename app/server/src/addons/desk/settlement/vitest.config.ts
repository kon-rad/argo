import { defineConfig } from 'vitest/config';

// Standalone unit suite: no vault configuration, PostgreSQL setup or live RPC.
export default defineConfig({
  test: {
    include: ['app/server/src/addons/desk/settlement/arc*.test.ts', 'app/server/src/addons/desk/settlement/rpc.test.ts'],
    environment: 'node',
  },
});
