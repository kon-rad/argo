import { createHash } from 'node:crypto';
import { commandDefinition, hostRegistry, type HostRegistry } from '@secondbrain/contracts/hosts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compareIds = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function registrySnapshot(input: HostRegistry) {
  // Parse back into schema key order after a jsonb round trip; sort only the copy.
  const registry = hostRegistry.parse(input);
  registry.commands.sort(compareIds);
  registry.machines.sort(compareIds);
  for (const machine of registry.machines) machine.commands.sort();
  return { registry, revision: digest(registry) };
}

export function commandRevision(definition: HostRegistry['commands'][number]) {
  return digest(commandDefinition.parse(definition));
}
