import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { hostRegistry, type HostRegistry } from '@secondbrain/contracts/hosts';

const routingMetadata = z.strictObject({
  role: z.string().optional(),
  ssh: z.string().optional(),
  worktree_root: z.string().optional(),
});

function directory(parent: string, name: string): string {
  const path = join(parent, name);
  if (!lstatSync(path).isDirectory()) throw new Error(`Host registry requires a regular directory: ${name}`);
  return path;
}

function definitions(config: string, kind: 'machines' | 'commands'): unknown[] {
  const path = directory(config, kind);
  return readdirSync(path).filter(name => name.endsWith('.yaml')).sort().map(name => {
    const filename = join(path, name);
    const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid source');
      const data = yaml.safeLoad(readFileSync(fd, 'utf8'));
      if (!data || typeof data !== 'object' || !('id' in data) || data.id !== name.slice(0, -5))
        throw new Error('ID must match filename');
      if (kind === 'machines' && 'routing' in data) {
        const { routing, ...policy } = data;
        routingMetadata.parse(routing);
        return policy;
      }
      return data;
    } catch {
      // YAML diagnostics may quote private file contents.
      throw new Error(`Invalid host registry definition in ${kind}/${name}`);
    } finally { closeSync(fd); }
  });
}

export function readHostRegistry(vaultRoot: string): HostRegistry {
  const config = ['.agents', 'org', 'config'].reduce(directory, resolve(vaultRoot));
  const result = hostRegistry.safeParse({ commands: definitions(config, 'commands'), machines: definitions(config, 'machines') });
  if (!result.success) throw new Error('Invalid host registry fields or command reference');
  return result.data;
}
