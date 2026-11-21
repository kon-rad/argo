import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { query, withTransaction, type TxClient } from '../db.js';
import { config } from '../config.js';
import { sameAssignment } from './launcher.js';
import { OrgError } from '../org-error.js';

export { TargetSchema, ProfileSchema } from './types.js';
import { AssignmentSchema, TargetSchema, ProfileSchema, type Target, type Profile, type Assignment } from './types.js';
import { assignmentProblem } from './resolve.js';
export interface Change { target: Target; from: Assignment; to: Assignment; problem: string | null }
export interface Preview { token: string; profileId: string; rosterVersion: string; profileVersion: number; changes: Change[]; uncovered: Target[]; expiresAt: string; inFlight: unknown[] }
interface AgentRow { name: string; runtime: string; model: string | null; capabilities: string[]; org_version: string; retired_at: Date | null }
interface Override { agent: string; runtime: string | null; model: string | null; effort: string | null; paused: boolean; set_by: string; set_at: Date }
const db: TxClient = { query };
const key = (t: Target) => `${t.kind}:${t.id}`;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function requireRuntimeOwner(by: string, tx: TxClient = db): Promise<void> {
  const r = await tx.query(`SELECT 1 FROM org_agents WHERE name=$1 AND runtime='human' AND retired_at IS NULL`, [by]);
  if (by !== config.orgOwner || !r.rows.length) throw new OrgError('only the owner can manage runtime profiles');
}
// Shared table lock order also used by roster import. Override edits take a conflicting row-exclusive lock.
async function lock(tx: TxClient) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('org-runtime-controller'))");
  await tx.query('LOCK TABLE org_agents, org_agent_overrides, org_runtime_profiles, org_runtime_targets, org_runtime_versions IN SHARE ROW EXCLUSIVE MODE');
}
async function snapshot(tx: TxClient) {
  const agents = (await tx.query<AgentRow>(`SELECT name,runtime,model,capabilities,org_version,retired_at FROM org_agents ORDER BY name`)).rows;
  const overrides = (await tx.query<Override>('SELECT * FROM org_agent_overrides ORDER BY agent')).rows;
  const registry = (await tx.query<{kind: Target['kind']; id: string; configured: Assignment; observed: Assignment|null; supported: Assignment[]; probe_status:string; fresh:boolean|null}>(`SELECT kind,id,configured,observed,supported,probe_status, checked_at > clock_timestamp() - interval '5 minutes' AS fresh FROM org_runtime_targets ORDER BY kind,id`)).rows;
  const latest = (await tx.query<{version: number}>('SELECT version FROM org_runtime_versions ORDER BY version DESC LIMIT 1')).rows[0]?.version ?? 0;
  const targets = agents.filter(a => !a.retired_at && !['human','session'].includes(a.runtime)).map(a => {
    const o = overrides.find(o => o.agent === a.name);
    return { kind: 'org-agent' as const, id: a.name, configured: {runtime:a.runtime,model:a.model,provider:null}, effective: {runtime:o?.runtime ?? a.runtime, model:o?.model ?? a.model, provider:null} as Assignment, capabilities:a.capabilities, adapter:'org-next-claim', health:'not-probed', supported:[] as Assignment[] };
  });
  return { agents, overrides, latest, targets: [...targets, ...registry.map(t => ({...t, effective:t.observed ?? t.configured, capabilities:[] as string[], adapter:t.fresh && t.probe_status === 'ready' ? 'launcher-controller' : null,
    health:t.probe_status === 'unsupported' || t.fresh ? t.probe_status : 'stale'}))], fingerprint: hash({ agents, overrides, registry, latest }) };
}
export async function saveProfile(id: string, input: unknown, by: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new OrgError('invalid profile id');
  const definition = ProfileSchema.parse(input);
  return withTransaction(async tx => {
    await lock(tx); await requireRuntimeOwner(by, tx);
    const version = Number((await tx.query(`SELECT coalesce(max(version),0)+1 AS version FROM org_runtime_profiles WHERE id=$1`, [id])).rows[0]!.version);
    await tx.query(`INSERT INTO org_runtime_profiles(id,version,definition,created_by) VALUES ($1,$2,$3,$4)`, [id,version,definition,by]);
    return { id, version, definition };
  });
}
/** Register inventory, never health. A controller probe must establish readiness. */
export async function registerRuntimeTarget(target: Target, configured: unknown, by: string) {
  const t = TargetSchema.parse(target);
  const assignment = AssignmentSchema.parse(configured);
  if (t.kind === 'org-agent' || t.id === 'unregistered') throw new OrgError('org targets come from the roster; use a real launcher id');
  return withTransaction(async tx => {
    await lock(tx); await requireRuntimeOwner(by,tx);
    await tx.query(`INSERT INTO org_runtime_targets(kind,id,configured) VALUES ($1,$2,$3) ON CONFLICT(kind,id) DO UPDATE SET configured=EXCLUDED.configured, probe_status='unsupported',observed=NULL,supported='[]',checked_at=NULL`,[t.kind,t.id,assignment]);
    await tx.query(`DELETE FROM org_runtime_targets WHERE kind=$1 AND id='unregistered'`,[t.kind]);
    return {...t,configured:assignment,adapter:null,health:'unsupported'};
  });
}
async function profiles(tx: TxClient) { return (await tx.query<{id:string;version:number;definition:Profile}>(`SELECT DISTINCT ON(id) id,version,definition FROM org_runtime_profiles ORDER BY id,version DESC`)).rows; }
export async function runtimeReceipts(version: number) {
  return (await query('SELECT * FROM org_runtime_receipts WHERE version=$1 ORDER BY kind,target_id',[version])).rows;
}
export async function runtimeStatus() {
  const s = await snapshot(db);
  const history = (await query('SELECT * FROM org_runtime_versions ORDER BY version DESC')).rows;
  const receipts = (await query('SELECT * FROM org_runtime_receipts ORDER BY version DESC,kind,target_id')).rows;
  const observed = (await query(`SELECT DISTINCT ON(agent_name) agent_name,runtime,model,started_at FROM usage_runs WHERE agent_name IS NOT NULL ORDER BY agent_name,started_at DESC NULLS LAST,session_id`)).rows;
  return { desiredVersion:s.latest, profiles:await profiles(db), profileRevisions:(await query('SELECT * FROM org_runtime_profiles ORDER BY id,version DESC')).rows, targets:s.targets.map(t => ({...t, lastObserved: t.kind === 'org-agent' ? observed.find(o => o.agent_name === t.id) ?? null : null})), history, receipts };
}
export async function previewRuntime(profileId: string, scope: Target[], by: string): Promise<Preview> {
  const selected = z.array(TargetSchema).max(10000).parse(scope);
  return withTransaction(async tx => {
    await lock(tx); await requireRuntimeOwner(by,tx);
    const p = (await profiles(tx)).find(p => p.id === profileId);
    if (!p) throw new OrgError('unknown runtime profile');
    const s = await snapshot(tx);
    const keys = new Set(selected.map(key));
    if (keys.size !== selected.length) throw new OrgError('duplicate target in scope');
    if (selected.some(t => !s.targets.some(r => key(r) === key(t)))) throw new OrgError('unknown target in scope');
    const unknownExceptions = Object.keys(p.definition.exceptions).filter(k => !s.targets.some(t => key(t) === k));
    if (unknownExceptions.length) throw new OrgError(`unknown profile exceptions: ${unknownExceptions.join(', ')}`);
    const changes = s.targets.filter(t => !selected.length || keys.has(key(t))).map(t => {
      const cap = ['deploy','merge','review','code'].find(c => t.capabilities.includes(c) && p.definition.capabilities[c as keyof Profile['capabilities']]);
      const assignment = p.definition.exceptions[key(t)] ?? (cap ? p.definition.capabilities[cap as keyof Profile['capabilities']] : undefined) ?? p.definition.default;
      const to = {...assignment,model:assignment.model ?? t.configured.model};
      return { target:{kind:t.kind,id:t.id}, from:t.effective, to, health:t.health, adapter:t.adapter, problem:!t.adapter ? 'unsupported: no ready launcher adapter'
        : t.kind !== 'org-agent' && !t.supported.some(a => sameAssignment(a,to)) ? 'launcher preflight unavailable for assignment'
        : assignmentProblem(to,t.capabilities,p.definition) };
    });
    const inFlight = (await tx.query(`SELECT id,agent_name,runtime,claimed_at,lease_until FROM card_runs WHERE finished_at IS NULL ORDER BY id`)).rows;
    const preview: Preview = {inFlight,token:randomUUID(),profileId,profileVersion:p.version,rosterVersion:s.fingerprint,changes,uncovered:s.targets.filter(t => selected.length && !keys.has(key(t))).map(t => ({kind:t.kind,id:t.id})),expiresAt:new Date(Date.now()+5*60_000).toISOString()};
    await tx.query(`INSERT INTO org_runtime_previews(token,snapshot,payload,expires_at,created_by) VALUES ($1,$2,$3,$4,$5)`, [preview.token,s.fingerprint,preview,preview.expiresAt,by]);
    return preview;
  });
}
async function commit(tx: TxClient, s: Awaited<ReturnType<typeof snapshot>>, p: Preview, by: string, revert: number | null = null, restore?: (Override | null)[]) {
  const version = s.latest+1;
  const status = p.changes.some(c => c.target.kind !== 'org-agent') ? 'partially-applied' : 'org-applied';
  const previous = p.changes.map(c => c.target.kind === 'org-agent' ? s.overrides.find(o => o.agent === c.target.id) ?? null : null);
  await tx.query(`INSERT INTO org_runtime_versions(version,profile_id,profile_version,changes,previous_overrides,applied_by,reverted_version,status,uncovered) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [version,p.profileId,p.profileVersion,JSON.stringify(p.changes),JSON.stringify(previous),by,revert,status,JSON.stringify(p.uncovered)]);
  for (const [i,c] of p.changes.entries()) {
    if (c.target.kind !== 'org-agent') {
      await tx.query(`INSERT INTO org_runtime_receipts(version,kind,target_id,status,assignment) VALUES ($1,$2,$3,'pending',$4)`,[version,c.target.kind,c.target.id,c.to]);
      await tx.query('UPDATE org_runtime_targets SET checked_at=NULL WHERE kind=$1 AND id=$2',[c.target.kind,c.target.id]);
      continue;
    }
    if (restore) {
      const o = restore[i];
      // Profile switches own runtime/model only. Preserve later pause and effort decisions.
      if (!o) {
        await tx.query('UPDATE org_agent_overrides SET runtime=NULL,model=NULL,set_by=$2,set_at=now() WHERE agent=$1',[c.target.id,by]);
        await tx.query('DELETE FROM org_agent_overrides WHERE agent=$1 AND effort IS NULL AND NOT paused',[c.target.id]);
      } else await tx.query(`INSERT INTO org_agent_overrides(agent,runtime,model,set_by) VALUES ($1,$2,$3,$4) ON CONFLICT(agent) DO UPDATE SET runtime=EXCLUDED.runtime,model=EXCLUDED.model,set_by=EXCLUDED.set_by,set_at=now()`,[o.agent,o.runtime,o.model,by]);
    } else {
      await tx.query(`INSERT INTO org_agent_overrides(agent,runtime,model,set_by) VALUES ($1,$2,$3,$4) ON CONFLICT(agent) DO UPDATE SET runtime=EXCLUDED.runtime,model=EXCLUDED.model,set_by=EXCLUDED.set_by,set_at=now()`,[c.target.id,c.to.runtime,c.to.model,by]);
    }
    await tx.query(`INSERT INTO org_runtime_receipts(version,kind,target_id,status,assignment) VALUES ($1,$2,$3,'effective-next-claim',$4)`,[version,c.target.kind,c.target.id,c.to]);
  }
  return {version,status,changes:p.changes,uncovered:p.uncovered};
}
export async function applyRuntime(token: string, by: string) {
  return withTransaction(async tx => {
    await lock(tx); await requireRuntimeOwner(by,tx);
    const row = (await tx.query<{payload:Preview;snapshot:string;expires_at:Date;used:boolean}>(`SELECT * FROM org_runtime_previews WHERE token=$1 FOR UPDATE`,[token])).rows[0];
    if (!row || row.used) throw new OrgError('unknown or used preview');
    if (row.expires_at.getTime() <= Date.now()) throw new OrgError('expired preview');
    const s = await snapshot(tx); const p = row.payload;
    if (row.snapshot !== s.fingerprint || (await profiles(tx)).find(r => r.id === p.profileId)?.version !== p.profileVersion) throw new OrgError('stale preview; preview again');
    const blocked = p.changes.filter(c => c.problem);
    if (blocked.length) throw new OrgError(blocked.map(c => `${key(c.target)}: ${c.problem}`).join('; '));
    // Null model inherits in the existing effective view, so validate that resolved pair too.
    const definition = (await profiles(tx)).find(r => r.id === p.profileId)!.definition;
    for (const c of p.changes) {
      if (c.target.kind !== 'org-agent') continue;
      const a = s.agents.find(a => a.name === c.target.id)!;
      const problem = assignmentProblem({...c.to,model:c.to.model ?? a.model},a.capabilities,definition);
      if (problem) throw new OrgError(problem);
    }
    const result = await commit(tx,s,p,by);
    await tx.query('UPDATE org_runtime_previews SET used=true WHERE token=$1',[token]);
    return result;
  });
}
export async function revertRuntime(version: number, by: string) {
  return withTransaction(async tx => {
    await lock(tx); await requireRuntimeOwner(by,tx);
    const r = (await tx.query<{profile_id:string;profile_version:number;changes:Change[];previous_overrides:(Override|null)[]}>(`SELECT * FROM org_runtime_versions WHERE version=$1`,[version])).rows[0];
    if (!r) throw new OrgError('unknown desired version');
    const s = await snapshot(tx);
    if (version !== s.latest) throw new OrgError('stale desired version');
    const definition = (await tx.query<{definition:Profile}>(`SELECT definition FROM org_runtime_profiles WHERE id=$1 AND version=$2`,[r.profile_id,r.profile_version])).rows[0]!.definition;
    const changes = r.changes.map((c,i) => {
      const t = s.targets.find(t => key(t) === key(c.target));
      if (!t || !t.adapter) throw new OrgError('revert target unavailable');
      const o = r.previous_overrides[i];
      if (c.target.kind !== 'org-agent') {
        if (!t.supported.some(a => sameAssignment(a,c.from))) throw new OrgError('revert preflight unavailable');
        if (!sameAssignment(t.effective,c.to) && !sameAssignment(t.effective,c.from)) throw new OrgError('revert blocked by launcher drift');
        return {target:c.target,from:t.effective,to:c.from,problem:null};
      }
      if (t.effective.runtime !== c.to.runtime || t.effective.model !== c.to.model) throw new OrgError('revert blocked by override drift');
      const to = {runtime:o?.runtime ?? t.configured.runtime,model:o?.model ?? t.configured.model,provider:null};
      const problem = assignmentProblem(to,t.capabilities,definition);
      if (problem) throw new OrgError(`revert blocked: ${problem}`);
      return {target:c.target,from:t.effective,to,problem:null};
    });
    return commit(tx,s,{token:'',profileId:r.profile_id,profileVersion:r.profile_version,rosterVersion:s.fingerprint,changes,uncovered:s.targets.filter(t => !changes.some(c => key(c.target) === key(t))).map(t => ({kind:t.kind,id:t.id})),expiresAt:'',inFlight:[]},by,version,r.previous_overrides);
  });
}
