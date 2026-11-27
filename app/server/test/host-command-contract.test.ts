import { describe, expect, it } from 'vitest';
import { commandDefinition, commandRequest, hostRegistry, launchReceipt, machineDefinition } from '@secondbrain/contracts/hosts';

describe('host command protocol', () => {
  it('takes typed text input without an executable or claimed identity', () => {
    const request = { command: 'word-count', requestKey: 'example', text: 'one two three' };
    expect(commandRequest.safeParse(request).success).toBe(true);
    expect(commandRequest.safeParse({ ...request, executable: '/bin/sh' }).success).toBe(false);
  });
  it('rejects references to undeclared commands', () => {
    expect(hostRegistry.safeParse({ machines: [{ id: 'sample', enabled: true, slots: 1, commands: ['missing'] }], commands: [] }).success).toBe(false);
  });
  it('accepts independent session and command permissions, plus optional RAM declared in GiB', () => {
    const machine = { id: 'sample', enabled: true, slots: 1, commands: [] };
    expect(machineDefinition.parse(machine).commands).toEqual([]);
    expect(machineDefinition.parse({ ...machine, allowAgentSessions: true, ramGiB: 1.5 })).toMatchObject({
      allowAgentSessions: true, ramGiB: 1.5, commands: [],
    });
    const command = { id: 'count', handler: 'word-count' };
    expect(commandDefinition.parse({ ...command, minRamGiB: 1.5 }).minRamGiB).toBe(1.5);
    for (const invalid of [0, -1, Infinity, '8']) {
      expect(machineDefinition.safeParse({ ...machine, ramGiB: invalid }).success).toBe(false);
      expect(commandDefinition.safeParse({ ...command, minRamGiB: invalid }).success).toBe(false);
    }
    expect(machineDefinition.safeParse({ ...machine, allowAgentSessions: 'true' }).success).toBe(false);
  });

  it('requires an observed process for the launch receipt', () => {
    expect(launchReceipt.safeParse({ attempt: 'attempt1', generation: 1 }).success).toBe(false);
  });
});
