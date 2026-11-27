import type { HostRegistry } from '@secondbrain/contracts/hosts';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { HostRegistryStore } from '../src/hosts/registry.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = new HostRegistryStore(pool);
const initial: HostRegistry = {
  commands: [{ id: 'count', handler: 'word-count' }, { id: 'words', handler: 'word-count' }],
  machines: [{ id: 'sample', commands: ['count', 'words'], slots: 1, enabled: true }],
};

async function resetRegistry() {
  await pool.query('UPDATE hc_registry_head SET revision = NULL');
  await pool.query('DELETE FROM hc_registry_snapshots');
}
beforeAll(resetRegistry);
afterEach(resetRegistry);
afterAll(() => pool.end());

it('previews a deterministic revision and changed records without applying', async () => {
  expect(await store.active()).toBeNull();
  const first = await store.preview(initial);
  expect(first).toMatchObject({ baseRevision: null, changes: [
    { section: 'commands', id: 'count', kind: 'added' }, { section: 'commands', id: 'words', kind: 'added' },
    { section: 'machines', id: 'sample', kind: 'added' },
  ] });
  expect(first.changes[0]).toEqual({ section: 'commands', id: 'count', kind: 'added', before: null, after: initial.commands[0] });
  expect(first.revision).toMatch(/^[0-9a-f]{64}$/);
  expect(await store.active()).toBeNull();

  const reordered: HostRegistry = { commands: initial.commands.slice().reverse(), machines: [
    { slots: 1, id: 'sample', commands: ['words', 'count'], enabled: true },
  ] };
  expect(await store.apply(reordered, null, first.revision)).toEqual({ revision: first.revision });
  expect(await store.preview(initial)).toEqual({ baseRevision: first.revision, revision: first.revision, changes: [] });
  const next = { commands: [initial.commands[0]!], machines: [{ ...initial.machines[0]!, commands: ['count'] }] };
  expect((await store.preview(next)).changes).toEqual([
    { section: 'commands', id: 'words', kind: 'removed', before: initial.commands[1], after: null },
    { section: 'machines', id: 'sample', kind: 'changed', before: initial.machines[0], after: next.machines[0] },
  ]);
});

it('leaves the last applied configuration intact after an invalid or changed candidate', async () => {
  const { revision } = await store.preview(initial);
  await store.apply(initial, null, revision);
  const snapshot = await store.active();
  await expect(store.apply({ ...initial, commands: [] }, revision, revision)).rejects.toMatchObject({ status: 400 });
  const changed = { ...initial, machines: [] };
  await expect(store.apply(changed, revision, revision)).rejects.toMatchObject({ status: 409 });
  expect(await store.active()).toEqual(snapshot);
});

it('accepts only one concurrent change from the same base', async () => {
  const options = [initial, { ...initial, machines: [] }];
  const plans = await Promise.all(options.map(option => store.preview(option)));
  const writes = await Promise.allSettled(options.map((option, i) => store.apply(option, null, plans[i]!.revision)));
  const winner = writes.findIndex(write => write.status === 'fulfilled');
  expect(writes.filter(write => write.status === 'fulfilled')).toHaveLength(1);
  expect(writes[1 - winner]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
  expect((await store.active())?.revision).toBe(plans[winner]!.revision);
  expect((await pool.query('SELECT revision FROM hc_registry_snapshots')).rows).toEqual([{ revision: plans[winner]!.revision }]);
});

it('holds the applied policy stable for a host action', async () => {
  await expect(store.withActive(async () => undefined)).rejects.toMatchObject({ status: 503 });
  const { revision } = await store.preview(initial);
  await store.apply(initial, null, revision);
  await store.withActive(async (registry, db) => {
    expect(registry).toEqual(initial);
    const lockedHead = await db.query('SELECT revision FROM hc_registry_head');
    expect(lockedHead.rows[0].revision).toBe(revision);
    await expect(pool.query('SELECT * FROM hc_registry_head FOR UPDATE NOWAIT')).rejects.toMatchObject({ code: '55P03' });
  });
  await pool.query('SELECT * FROM hc_registry_head FOR UPDATE NOWAIT');
});
