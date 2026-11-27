import { describe, expect, it } from 'vitest';
import { commandRequest, hostRegistry, launchReceipt } from '@secondbrain/contracts/hosts';

describe('host command protocol', () => {
  it('takes typed text input without an executable or claimed identity', () => {
    const request = { command: 'word-count', requestKey: 'example', text: 'one two three' };
    expect(commandRequest.safeParse(request).success).toBe(true);
    expect(commandRequest.safeParse({ ...request, executable: '/bin/sh' }).success).toBe(false);
  });
  it('rejects references to undeclared commands', () => {
    expect(hostRegistry.safeParse({ machines: [{ id: 'sample', enabled: true, slots: 1, commands: ['missing'] }], commands: [] }).success).toBe(false);
  });
  it('requires an observed process for the launch receipt', () => {
    expect(launchReceipt.safeParse({ attempt: 'attempt1', generation: 1 }).success).toBe(false);
  });
});
