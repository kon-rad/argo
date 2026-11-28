import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const unique = (values: string[]) => new Set(values).size === values.length;

// Pilot command handlers are built into the worker. Requests contain data only.
export const commandDefinition = z.strictObject({
  id, handler: z.literal('word-count'), minRamGiB: z.number().positive().optional(),
});
export const machineDefinition = z.strictObject({
  id, enabled: z.boolean(), slots: z.number().int().min(1).max(128),
  commands: z.array(id).refine(unique, 'duplicate command'),
  ramGiB: z.number().positive().optional(),
  allowAgentSessions: z.boolean().optional(),
});
export const hostRegistry = z.strictObject({
  commands: z.array(commandDefinition), machines: z.array(machineDefinition),
}).superRefine((registry, ctx) => {
  const commands = registry.commands.map(record => record.id);
  if (!unique(commands) || !unique(registry.machines.map(record => record.id)))
    ctx.addIssue({ code: 'custom', message: 'duplicate registry identity' });
  for (const machine of registry.machines)
    for (const command of machine.commands)
      if (!commands.includes(command)) ctx.addIssue({ code: 'custom', message: 'unknown command: ' + command });
});
export const artifactMaxBytes = 4 * 1024 * 1024;
export const artifactRef = z.strictObject({
  id: z.uuid(), bytes: z.number().int().min(0).max(artifactMaxBytes), sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ArtifactRef = z.infer<typeof artifactRef>;
const inputs = { text: z.string().max(65536).optional(), input: artifactRef.optional() };
const oneInput = (data: { text?: string; input?: ArtifactRef }) => (data.text === undefined) !== (data.input === undefined);
export const commandRequest = z.strictObject({ command: id, requestKey: id, ...inputs }).refine(oneInput, 'Expected one input');
export const commandLease = z.strictObject({
  commandRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  registryRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  runId: id.optional(), deadline: z.iso.datetime().optional(),
  attempt: id, generation: z.number().int().positive(), command: id, handler: z.literal('word-count'), ...inputs,
}).refine(oneInput, 'Expected one input');
export const launchReceipt = z.strictObject({
  attempt: id, generation: z.number().int().positive(), pid: z.number().int().positive(),
});
export const commandResult = z.discriminatedUnion('outcome', [
  z.strictObject({ attempt: id, generation: z.number().int().positive(), outcome: z.literal('succeeded'), count: z.number().int().nonnegative(), output: artifactRef.optional() }),
  z.strictObject({ attempt: id, generation: z.number().int().positive(), outcome: z.literal('unknown'), reason: z.string().min(1).max(512) }),
  z.strictObject({ attempt: id, generation: z.number().int().positive(), outcome: z.literal('failed'), reason: z.string().min(1).max(512) }),
]);
export type HostRegistry = z.infer<typeof hostRegistry>;
export type CommandLease = z.infer<typeof commandLease>;
export type CommandResult = z.infer<typeof commandResult>;
