import { registrySnapshot } from './revisions.js';
import { hostRegistry, type HostRegistry } from '@secondbrain/contracts/hosts';
import type { Pool, PoolClient } from 'pg';
import { HostServiceError } from './service.js';

type Snapshot = { revision: string; registry: HostRegistry };
type Section = 'commands' | 'machines';
type Definition = HostRegistry[Section][number];
type Change = {
  section: Section;
  id: string;
  kind: 'added' | 'changed' | 'removed';
  before: Definition | null;
  after: Definition | null;
};

function compile(candidate: unknown): Snapshot {
  // Parsing also orders object keys according to the shared schema. PostgreSQL jsonb
  // can reorder those keys, so always parse stored snapshots before comparing.
  const result = hostRegistry.safeParse(candidate);
  if (!result.success) throw new HostServiceError(400, 'Invalid host registry');
  return registrySnapshot(result.data);
}

function diff(before: HostRegistry | undefined, after: HostRegistry): Change[] {
  const changes: Change[] = [];
  for (const section of ['commands', 'machines'] as const) {
    const prior = new Map<string, Definition>((before?.[section] ?? []).map(row => [row.id, row]));
    const next = new Map<string, Definition>(after[section].map(row => [row.id, row]));
    for (const id of [...new Set([...prior.keys(), ...next.keys()])].sort()) {
      const oldRecord = prior.get(id) ?? null;
      const newRecord = next.get(id) ?? null;
      if (JSON.stringify(oldRecord) === JSON.stringify(newRecord)) continue;
      const kind = !oldRecord ? 'added' : !newRecord ? 'removed' : 'changed';
      changes.push({ section, id, kind, before: oldRecord, after: newRecord });
    }
  }
  return changes;
}

export class HostRegistryStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(run: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const value = await run(db);
      await db.query('COMMIT');
      return value;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally { db.release(); }
  }

  async active(): Promise<Snapshot | null> {
    const { rows } = await this.pool.query<Snapshot>(
      'SELECT revision, registry FROM hc_registry_head JOIN hc_registry_snapshots USING (revision)');
    return rows[0] ? { revision: rows[0].revision, registry: hostRegistry.parse(rows[0].registry) } : null;
  }

  async preview(candidate: unknown) {
    const compiled = compile(candidate);
    const current = await this.active();
    return {
      baseRevision: current?.revision ?? null,
      revision: compiled.revision,
      changes: diff(current?.registry, compiled.registry),
    };
  }

  async apply(candidate: unknown, baseRevision: string | null, expectedRevision: string): Promise<{revision: string}> {
    const { registry, revision } = compile(candidate);
    if (expectedRevision !== revision) throw new HostServiceError(409, 'Registry changed since preview');
    return this.transaction(async db => {
      const { rows } = await db.query<{revision: string | null}>('SELECT revision FROM hc_registry_head FOR UPDATE');
      if (rows[0]?.revision !== baseRevision) throw new HostServiceError(409, 'Active registry changed since preview');
      if (revision !== baseRevision) {
        await db.query('INSERT INTO hc_registry_snapshots (revision, registry) VALUES ($1, $2) ON CONFLICT (revision) DO NOTHING',
          [revision, JSON.stringify(registry)]);
        await db.query('UPDATE hc_registry_head SET revision = $1 WHERE singleton', [revision]);
      }
      return { revision };
    });
  }

  async withActive<T>(run: (registry: HostRegistry, db: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(async db => {
      const { rows } = await db.query<{revision: string | null}>('SELECT revision FROM hc_registry_head FOR SHARE');
      const revision = rows[0]?.revision;
      if (!revision) throw new HostServiceError(503, 'Host registry has not been applied');
      const snapshot = await db.query<{registry: HostRegistry}>(
        'SELECT registry FROM hc_registry_snapshots WHERE revision = $1', [revision]);
      return run(hostRegistry.parse(snapshot.rows[0]!.registry), db);
    });
  }
}
