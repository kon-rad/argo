// Trusted host entry points. The HTTP server never imports host adapters.
import { pool } from '../db.js';
import type { PoolClient } from 'pg';
import { OrgError } from '../org-error.js';
import { AssignmentSchema, type Assignment } from './types.js';
import { ready, runLauncher, type LauncherAdapter, type LauncherKind } from './launcher.js';

type Launcher = { kind: LauncherKind; id: string };
export type AdapterRegistry = ReadonlyMap<string, LauncherAdapter>;

// The same lock is acquired transactionally by desired-state writers. A session
// lock fences host work across autocommitted receipts without an open transaction.
async function fenced<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  let unlocked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('org-runtime-controller'))");
    return await fn(client);
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('org-runtime-controller'))");
      unlocked = true;
    } finally { client.release(!unlocked); }
  }
}

/** Probe owner-inventoried targets. Only the reviewed host supplies adapters and candidate assignments. */
export async function refreshLaunchers(registry: AdapterRegistry, candidates: readonly Assignment[]) {
  const assignments = candidates.map(a => AssignmentSchema.parse(a));
  await fenced(async client => {
    const {rows} = await client.query<Launcher>('SELECT kind,id FROM org_runtime_targets ORDER BY kind,id');
    for (const target of rows) {
      const adapter = registry.get(`${target.kind}:${target.id}`);
      let probeStatus = 'unsupported';
      let observed: Assignment | null = null;
      const supported: Assignment[] = [];
      if (adapter && target.id !== 'unregistered') {
        probeStatus = 'unhealthy';
        try {
          const state = await adapter.inspect();
          if (ready(target.kind,state)) {
            observed = AssignmentSchema.parse(state.assignment);
            for (const a of assignments) if (await adapter.preflight(a)) supported.push(a);
            probeStatus = 'ready';
          }
        } catch { supported.length = 0; observed = null; }
      }
      await client.query(`UPDATE org_runtime_targets SET observed=COALESCE($3,observed),supported=$4,probe_status=$5,checked_at=clock_timestamp()
        WHERE kind=$1 AND id=$2`,[target.kind,target.id,observed,JSON.stringify(supported),probeStatus]);
    }
  });
}

export async function reconcileLaunchers(expectedVersion: number, registry: AdapterRegistry) {
  return fenced(async client => {
    const {rows:[head]} = await client.query('SELECT max(version) AS version FROM org_runtime_versions');
    if (head?.version !== expectedVersion) throw new OrgError('stale desired version');
    // Scoped applies retain the latest intent for each untouched launcher.
    const {rows} = await client.query<{kind:LauncherKind;target_id:string;version:number;assignment:Assignment;previous:Assignment}>(`
      SELECT active.*, change->'from' AS previous FROM (SELECT DISTINCT ON(kind,target_id) kind,target_id,version,assignment
        FROM org_runtime_receipts WHERE kind <> 'org-agent' ORDER BY kind,target_id,version DESC) active
      JOIN org_runtime_versions v USING(version)
      CROSS JOIN LATERAL jsonb_array_elements(v.changes) change
      WHERE change->'target'->>'kind'=active.kind AND change->'target'->>'id'=active.target_id
      ORDER BY (active.kind='default-route'),active.kind,active.target_id`);
    let pollerFailed = false;
    for (const target of rows) {
      const adapter = registry.get(`${target.kind}:${target.target_id}`);
      const status = target.kind === 'default-route' && pollerFailed ? 'unhealthy'
        : await runLauncher(target.kind,target.version,target.assignment,adapter,target.previous);
      if (target.kind === 'telegram-poller' && status !== 'verified') pollerFailed = true;
      // Receipt and aggregate must survive a crash together.
      await client.query('BEGIN');
      try {
        await client.query(`UPDATE org_runtime_receipts SET status=$4,observed_at=clock_timestamp()
          WHERE version=$1 AND kind=$2 AND target_id=$3`,[target.version,target.kind,target.target_id,status]);
        if (status === 'verified') {
          await client.query('UPDATE org_runtime_targets SET observed=$3 WHERE kind=$1 AND id=$2',
            [target.kind,target.target_id,target.assignment]);
        } else {
          await client.query("UPDATE org_runtime_targets SET probe_status=$3,checked_at=clock_timestamp(),supported='[]' WHERE kind=$1 AND id=$2",
            [target.kind,target.target_id,status === 'unsupported' ? 'unsupported' : 'unhealthy']);
        }
        await client.query(`UPDATE org_runtime_versions SET status=CASE WHEN EXISTS (
          SELECT 1 FROM org_runtime_receipts WHERE version=$1 AND kind <> 'org-agent' AND status <> 'verified'
        ) THEN 'partially-applied' ELSE 'launchers-verified' END WHERE version=$1`,[target.version]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; }
    }
  });
}
