import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['server/test/review-unit.test.ts','server/test/review-scope.test.ts','server/test/codex-dispatch.test.ts','server/test/verification-runner.test.ts','server/test/verification-gate.test.ts'] } });
