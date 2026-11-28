import { linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { commandDefinition, machineDefinition } from '@secondbrain/contracts/hosts';

export const usage = [
  'secondbrain host-config machine <id>',
  'secondbrain host-config command <id> --handler word-count',
].join('\n');

function ensureDirectory(parent: string, name: string) {
  const path = join(parent, name);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!lstatSync(path).isDirectory()) throw new Error('Expected a regular directory: ' + path);
  return path;
}

export function scaffoldHostDefinition(vaultRoot: string, args: string[]): string {
  const [kind, id, flag, handler] = args;
  const machine = kind === 'machine' && args.length === 2;
  const command = kind === 'command' && args.length === 4 && flag === '--handler';
  if (!machine && !command) throw new Error(usage);
  const definition = machine
    ? machineDefinition.safeParse({ id, enabled: false, slots: 1, commands: [] })
    : commandDefinition.safeParse({ id, handler });
  if (!definition.success) throw new Error('Invalid ID or unsupported command handler.\n' + usage);

  const config = ['.agents', 'org', 'config'].reduce(ensureDirectory, vaultRoot);
  if (lstatSync(join(config, 'machines.yaml'), { throwIfNoEntry: false })) {
    throw new Error('Migrate the legacy machines.yaml roster before scaffolding host definitions.');
  }
  const machines = ensureDirectory(config, 'machines');
  const commands = ensureDirectory(config, 'commands');
  const dir = machine ? machines : commands;
  const target = join(dir, definition.data.id + '.yaml');
  // Publish a complete file with exclusive creation, including for concurrent callers.
  const staging = mkdtempSync(join(dir, '.scaffold-'));
  try {
    const source = join(staging, 'definition');
    writeFileSync(source, yaml.safeDump(definition.data), { mode: 0o600 });
    try {
      linkSync(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Definition already exists: ' + target);
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return target;
}
