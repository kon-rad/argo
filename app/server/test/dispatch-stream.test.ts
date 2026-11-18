import { expect, it } from 'vitest';
import { execRunner } from '../src/addons/dispatch/cli.js';
it('persists the first native line before the child exits, even when finalisation fails', async () => {
  const lines: string[] = [];
  const result = await execRunner(process.execPath, ['-e',
    `process.stdout.write('{"type":"thread.started","thread_id":"native-1"}\\n'); setTimeout(() => process.exit(1), 30);`],
    process.env, process.cwd(), 5000, async line => { lines.push(line); });
  expect(lines.map(line => JSON.parse(line))).toEqual([{ type: 'thread.started', thread_id: 'native-1' }]);
  expect(result.code).toBe(1);
});
it('propagates a failed durable identity write instead of reporting successful finalisation', async () => {
  await expect(execRunner(process.execPath, ['-e',
    `process.stdout.write('{"type":"thread.started","thread_id":"native-1"}\\n'); setTimeout(() => {}, 10000);`],
    process.env, process.cwd(), 5000, async () => { throw new Error('identity write failed'); }))
    .rejects.toThrow('identity write failed');
});
