import { beforeEach, expect, it } from 'vitest';
import { query, withTransaction } from '../src/db.js';
import { importOrg } from '../src/org.js';
import { applyOrg } from '../src/org-apply.js';
import { saveProfile, previewRuntime, applyRuntime, runtimeStatus, revertRuntime, registerRuntimeTarget } from '../src/org-runtime/index.js';
import { truncateAll } from './helpers.js';

const org = { version: 'v1', company: 'Example', ceo: 'owner', agents: {
  owner: { runtime: 'human', role: 'Owner' },
  builder: { runtime: 'codex', lane: true, model: 'example-code', role: 'Builder', capabilities: ['code'] },
  writer: { runtime: 'codex', lane: true, model: 'example-code', role: 'Writer' },
}, teams: {}, channels: {} };
const profile = { name: 'Example', default: { runtime: 'codex', model: 'example-next', provider: null },
  exceptions: {}, capabilities: {}, models: { 'example-code': { tier: 3, canCode: true }, 'example-next': { tier: 3, canCode: true } } };
const scope = [{ kind: 'org-agent' as const, id: 'builder' }, { kind: 'org-agent' as const, id: 'writer' }];
beforeEach(async () => { await truncateAll(); await importOrg(org); });
async function preview() { await saveProfile('example', profile, 'owner'); return previewRuntime('example', scope, 'owner'); }
it('rejects incompatible pairs and protected capability floors, and shows uncovered launchers', async () => {
  await saveProfile('bad', { ...profile, default: { ...profile.default, model: 'local/example' } }, 'owner');
  expect((await previewRuntime('bad', scope, 'owner')).changes[0]?.problem).toMatch(/codex/);
  await saveProfile('weak', { ...profile, models: { 'example-next': { tier: 1, canCode: false } } }, 'owner');
  expect((await previewRuntime('weak', scope, 'owner')).changes[0]?.problem).toMatch(/floor/);
  const p = await preview();
  expect(p.uncovered.map(t => t.kind)).toEqual(expect.arrayContaining(['cron-job', 'telegram-poller', 'telegram-gateway', 'default-route']));
  const all = await previewRuntime('example', [], 'owner');
  await expect(applyRuntime(all.token, 'owner')).rejects.toThrow(/adapter/);
});
it('applies once, records receipts, preserves history and reverts as a new version', async () => {
  const p = await preview(); const a = await applyRuntime(p.token, 'owner');
  expect(a.version).toBe(1);
  expect(a.status).toBe('org-applied');
  expect((await runtimeStatus()).targets.find(t => t.id === 'builder')?.effective.model).toBe('example-next');
  await expect(applyRuntime(p.token, 'owner')).rejects.toThrow(/stale|used/);
  const r = await revertRuntime(1, 'owner');
  expect(r.version).toBe(2);
  expect((await runtimeStatus()).targets.find(t => t.id === 'builder')?.effective.model).toBe('example-code');
});
it('rejects stale profile, roster, override and expired previews', async () => {
  let p = await preview(); await saveProfile('example', profile, 'owner');
  await expect(applyRuntime(p.token, 'owner')).rejects.toThrow(/stale/);
  p = await previewRuntime('example', scope, 'owner'); await query(`UPDATE org_agents SET capabilities = '{}' WHERE name='builder'`);
  await expect(applyRuntime(p.token, 'owner')).rejects.toThrow(/stale/);
  p = await previewRuntime('example', scope, 'owner');
  await query(`INSERT INTO org_agent_overrides(agent,model,set_by) VALUES ('writer','example-manual','owner')`);
  await expect(applyRuntime(p.token, 'owner')).rejects.toThrow(/stale/);
  p = await previewRuntime('example', scope, 'owner'); await query(`UPDATE org_runtime_previews SET expires_at=now()-interval '1 second'`);
  await expect(applyRuntime(p.token, 'owner')).rejects.toThrow(/expired/);
});
it('serializes concurrent applies so only one snapshot wins', async () => {
  const p = await preview(); const q = await previewRuntime('example', scope, 'owner');
  const results = await Promise.allSettled([applyRuntime(p.token, 'owner'), applyRuntime(q.token, 'owner')]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((await runtimeStatus()).history).toHaveLength(1);
});
it('rolls back overrides, receipts and desired version on a late database failure', async () => {
  const p = await preview();
  await query(`CREATE FUNCTION runtime_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
  await query(`CREATE TRIGGER runtime_test_fail BEFORE INSERT ON org_runtime_receipts FOR EACH ROW EXECUTE FUNCTION runtime_test_fail()`);
  try { await expect(applyRuntime(p.token, 'owner')).rejects.toThrow(/injected failure/); }
  finally { await query(`DROP TRIGGER runtime_test_fail ON org_runtime_receipts; DROP FUNCTION runtime_test_fail()`); }
  expect((await query(`SELECT * FROM org_agent_overrides`)).rows).toHaveLength(0);
  expect((await runtimeStatus()).history).toHaveLength(0);
  await applyRuntime(p.token, 'owner');
});
it('guards a 41-bot roster import against incompatible inherited overrides without writes', async () => {
  await query(`INSERT INTO org_agent_overrides(agent,model,set_by) VALUES ('builder','local/example','owner')`);
  const agents = Object.fromEntries(Array.from({length: 39}, (_,i) => [`bot-${i}`, { runtime: 'codex', lane: true, model: 'example-code', role: 'Writer' }]));
  await expect(applyOrg({ ...org, version: 'v2', agents: { ...org.agents, ...agents } })).rejects.toThrow(/builder.*codex/);
  expect((await query(`SELECT name FROM org_agents WHERE name LIKE 'bot-%'`)).rows).toHaveLength(0);
});
it('preserves selected overrides on valid import', async () => {
  await applyRuntime((await preview()).token, 'owner'); await applyOrg({ ...org, version: 'v2' });
  expect((await runtimeStatus()).targets.find(t => t.id === 'builder')?.effective.model).toBe('example-next');
});
it('rejects bot service writes and database role writes', async () => {
  await expect(saveProfile('x', profile, 'builder')).rejects.toThrow(/owner/);
  const p = await preview(); await expect(applyRuntime(p.token, 'builder')).rejects.toThrow(/owner/);
  await expect(withTransaction(async tx => { await tx.query('SET LOCAL ROLE sb_org'); await tx.query(`INSERT INTO org_runtime_profiles(id,version,definition,created_by) VALUES ('bad',1,'{}','builder')`); })).rejects.toThrow(/permission denied/);
});
it('rejects newly privileged roster capabilities below the active model floor', async () => {
  await saveProfile('writer-only',{...profile,models:{'example-next':{tier:1,canCode:false}}},'owner');
  await applyRuntime((await previewRuntime('writer-only',[{kind:'org-agent',id:'writer'}],'owner')).token,'owner');
  await expect(applyOrg({...org,version:'v2',agents:{...org.agents,writer:{...org.agents.writer,capabilities:['deploy']}}})).rejects.toThrow(/floor/);
  expect((await query(`SELECT capabilities FROM org_agents WHERE name='writer'`)).rows[0]?.capabilities).toEqual([]);
});
it('keeps registered launcher inventory unsupported and invalidates old previews', async () => {
  const p = await preview();
  try {
    await registerRuntimeTarget({kind:'cron-job',id:'daily'},profile.default,'owner');
    await expect(applyRuntime(p.token,'owner')).rejects.toThrow(/stale/);
    const all = await previewRuntime('example',[],'owner');
    expect(all.changes.find(c => c.target.id === 'daily')?.problem).toMatch(/adapter/);
  } finally {
    await query(`DELETE FROM org_runtime_targets WHERE kind='cron-job'`);
    await query(`INSERT INTO org_runtime_targets(kind,id,configured) VALUES ('cron-job','unregistered','{"runtime":"unknown","model":null,"provider":null}')`);
  }
});
it('revert preserves independent pause and effort decisions', async () => {
  await applyRuntime((await preview()).token,'owner');
  await query(`UPDATE org_agent_overrides SET paused=true,effort='high' WHERE agent='builder'`);
  await revertRuntime(1,'owner');
  expect((await query(`SELECT runtime,model,paused,effort FROM org_agent_overrides WHERE agent='builder'`)).rows[0]).toEqual({runtime:null,model:null,paused:true,effort:'high'});
});

it('fences scoped launcher work, records partial failure, and restores the observed baseline', async () => {
  const { refreshLaunchers, reconcileLaunchers } = await import('../src/org-runtime/controller.js');
  const { vi } = await import('vitest');
  const cron = {kind:'cron-job' as const,id:'daily'};
  const gateway = {kind:'telegram-gateway' as const,id:'inbox'};
  const base = {...profile.default,model:'example-before'};
  function host() {
    let state = {version:0,assignment:base,healthy:true};
    return {
      inspect:async () => state, preflight:async () => true,
      apply:vi.fn(async (version:number,assignment:typeof base) => { state = {version,assignment,healthy:true}; }),
      verify:vi.fn(async () => state),
    };
  }
  const a = host(), b = host();
  const registry = new Map([['cron-job:daily',a],['telegram-gateway:inbox',b]]);
  const refresh = () => refreshLaunchers(registry,[base,profile.default]);
  try {
    for (const t of [cron,gateway]) await registerRuntimeTarget(t,base,'owner');
    await saveProfile('example',profile,'owner');
    await refresh();
    const all = await previewRuntime('example',[],'owner');
    await expect(applyRuntime(all.token,'owner')).rejects.toThrow(/adapter/);
    const expired = await previewRuntime('example',[cron,gateway],'owner');
    await query("UPDATE org_runtime_targets SET checked_at=now()-interval '6 minutes' WHERE kind='cron-job'");
    await expect(applyRuntime(expired.token,'owner')).rejects.toThrow(/stale/);
    await refresh();
    const p = await previewRuntime('example',[cron,gateway],'owner');
    await expect(applyRuntime(p.token,'builder')).rejects.toThrow(/owner/);
    expect((await applyRuntime(p.token,'owner')).status).toBe('partially-applied');
    b.verify.mockRejectedValueOnce(new Error('private diagnostic'));
    await reconcileLaunchers(1,registry);
    const partial = await runtimeStatus();
    expect(partial.receipts.map(r => r.status)).toEqual(['verified','failed']);
    expect(partial.history[0]?.status).toBe('partially-applied');
    await reconcileLaunchers(1,registry);
    expect(a.apply).toHaveBeenCalledTimes(1);
    expect(b.apply).toHaveBeenCalledTimes(1);
    expect((await runtimeStatus()).history[0]?.status).toBe('launchers-verified');
    await refresh();
    expect((await revertRuntime(1,'owner')).version).toBe(2);
    await expect(reconcileLaunchers(1,registry)).rejects.toThrow(/stale/);
    await expect(revertRuntime(1,'owner')).rejects.toThrow(/stale/);
    await reconcileLaunchers(2,registry);
    expect((await a.inspect()).assignment).toEqual(base);
    expect((await b.inspect()).assignment).toEqual(base);
    expect((await runtimeStatus()).receipts).toHaveLength(4);
  } finally {
    for (const t of [cron,gateway]) await query(`UPDATE org_runtime_targets SET id='unregistered',
      configured='{"runtime":"unknown","model":null,"provider":null}',observed=NULL,supported='[]',probe_status='unsupported',checked_at=NULL
      WHERE kind=$1 AND id=$2`,[t.kind,t.id]);
  }
});

it('limits apply to the configured owner even with a second active human', async () => {
  await query("UPDATE org_agents SET runtime='human' WHERE name='writer'");
  await saveProfile('example',profile,'owner');
  const p = await previewRuntime('example',[scope[0]!],'owner');
  await expect(applyRuntime(p.token,'writer')).rejects.toThrow(/owner/);
  expect((await runtimeStatus()).history).toHaveLength(0);
});
