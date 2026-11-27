import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { hostCommandStatus, HostService, revokeHost } from '../src/hosts/service.js';

// The server suite's global setup creates and migrates DATABASE_URL before this file runs.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

function fixture() {
  const command = randomUUID();
  const machine = randomUUID();
  const second = randomUUID();
  const idle = randomUUID();
  const service = new HostService(pool, {
    commands: [{ id: command, handler: 'word-count' }],
    machines: [machine, second, idle].map(id => ({ id, enabled: true, slots: 1, commands: id === idle ? [] : [command] })),
  });
  return { command, machine, second, idle, service };
}

describe('host command service', () => {
  it('consumes enrollment once, stores a digest and honors token revocation', async () => {
    const { machine, service } = fixture();
    const previous = await service.issueCode(machine);
    const { code } = await service.issueCode(machine);
    await expect(service.enroll(previous.code)).rejects.toMatchObject({ status: 401 });
    const enrolled = await service.enroll(code);
    expect(await service.authenticate(enrolled.token)).toBe(machine);
    await expect(service.enroll(code)).rejects.toMatchObject({ status: 401 });
    await expect(service.issueCode(machine)).rejects.toMatchObject({ status: 409 });
    const { rows } = await pool.query('SELECT token_hash FROM hc_tokens WHERE machine=$1', [machine]);
    expect(rows[0].token_hash).toBe(createHash('sha256').update(enrolled.token).digest('hex'));
    await service.revoke(machine);
    await expect(service.authenticate(enrolled.token)).rejects.toMatchObject({ status: 401 });
  });

  it('recovers an accepted request after command removal, rejects changed input and denies new requests', async () => {
    const { command, service } = fixture();
    const request = { command, requestKey: randomUUID(), text: 'original' };
    const [accepted, replay] = await Promise.all([service.submit(request), service.submit(request)]);
    expect(replay).toEqual(accepted);
    const removed = new HostService(pool, { machines: [], commands: [] });
    expect(await removed.submit(request)).toEqual(accepted);
    await expect(removed.submit({ ...request, text: 'different' })).rejects.toMatchObject({ status: 409 });
    await expect(removed.submit({ ...request, command: randomUUID() })).rejects.toMatchObject({ status: 409 });
    await expect(removed.submit({ ...request, requestKey: randomUUID() })).rejects.toMatchObject({ status: 400 });
  });

  it('reads a run and revokes issued or enrolled credentials independently of the registry', async () => {
    const { service, command, machine, second } = fixture();
    const { id } = await service.submit({ command, requestKey: randomUUID(), text: '' });
    expect(await hostCommandStatus(pool, id)).toMatchObject({ id, command, state: 'queued' });
    await expect(hostCommandStatus(pool, randomUUID())).rejects.toMatchObject({ status: 404 });
    const { code } = await service.issueCode(machine);
    const pending = await service.issueCode(second);
    const { token } = await service.enroll(code);
    await revokeHost(pool, machine);
    await revokeHost(pool, second);
    await expect(service.authenticate(token)).rejects.toMatchObject({ status: 401 });
    await expect(service.enroll(pending.code)).rejects.toMatchObject({ status: 401 });
  });

  it('reserves once, preserves capacity until completion, rejects stale evidence and accepts exact replays', async () => {
    const { command, machine, idle, second, service } = fixture();
    const request = { command, requestKey: randomUUID(), text: 'one two' };
    const result = await service.submit(request);
    expect(await service.submit(request)).toEqual(result);
    await expect(service.submit({ ...request, text: 'changed' })).rejects.toMatchObject({ status: 409 });
    await service.submit({ ...request, requestKey: randomUUID() });
    expect(await service.poll(idle)).toBeNull();
    const reservations = await Promise.all([service.poll(machine), service.poll(machine)]);
    const leases = reservations.filter(lease => lease !== null);
    expect(leases).toHaveLength(1);
    const { attempt, generation } = leases[0]!;
    const receipt = { attempt, generation, pid: 123 };
    const finished = { attempt, generation, outcome: 'succeeded', count: 2 };
    await expect(service.finish(machine, finished)).rejects.toMatchObject({ status: 409 });
    await expect(service.start(second, receipt)).rejects.toMatchObject({ status: 409 });
    await expect(service.start(machine, { ...receipt, generation: generation + 1 })).rejects.toMatchObject({ status: 409 });
    await service.start(machine, receipt);
    await service.start(machine, receipt);
    await expect(service.start(machine, { ...receipt, pid: 321 })).rejects.toMatchObject({ status: 409 });
    await expect(service.poll(machine)).resolves.toBeNull();
    await expect(service.finish(second, finished)).rejects.toMatchObject({ status: 409 });
    await service.finish(machine, finished);
    await service.finish(machine, finished);
    await expect(service.finish(machine, { ...finished, count: 3 })).rejects.toMatchObject({ status: 409 });
    expect(await service.status(attempt)).toEqual({ id: attempt, command, machine, state: 'succeeded', pid: 123, generation, result: finished });
    const next = await service.poll(machine);
    expect(next).not.toBeNull();
    expect(next?.attempt).not.toBe(attempt);
  });

  it('matches declared RAM and command permission independently from session hosting', async () => {
    const heavy = randomUUID();
    const light = randomUUID();
    const commandHost = { id: randomUUID(), enabled: true, slots: 1, commands: [heavy, light] };
    const small = { ...commandHost, id: randomUUID(), ramGiB: 6 };
    const enough = { ...commandHost, id: randomUUID(), ramGiB: 8, allowAgentSessions: false };
    const sessions = { ...enough, id: randomUUID(), allowAgentSessions: true, commands: [] };
    const service = new HostService(pool, {
      commands: [{ id: heavy, handler: 'word-count', minRamGiB: 8 }, { id: light, handler: 'word-count' }],
      machines: [commandHost, small, enough, sessions],
    });
    const submit = (command: string) => service.submit({ command, requestKey: randomUUID(), text: 'pilot' });
    const heavyRun = await submit(heavy);
    expect(await service.poll(commandHost.id)).toBeNull();
    expect(await service.poll(small.id)).toBeNull();
    expect(await service.poll(sessions.id)).toBeNull();
    expect((await service.poll(enough.id))?.attempt).toBe(heavyRun.id);
    const lightRun = await submit(light);
    expect((await service.poll(commandHost.id))?.attempt).toBe(lightRun.id);
    await submit(light);
    expect((await service.poll(small.id))?.command).toBe(light);
  });

  it('checks current command policy before a reserved run starts and accepts an existing result after a policy change', async () => {
    const { machine, command, service } = fixture();
    const { code } = await service.issueCode(machine);
    const { token } = await service.enroll(code);
    const { id } = await service.submit({ command, requestKey: randomUUID(), text: 'pilot' });
    const lease = await service.poll(machine);
    expect(lease?.attempt).toBe(id);
    const removed = new HostService(pool, { machines: [], commands: [] });
    const withdrawn = new HostService(pool, {
      machines: [{ id: machine, enabled: true, slots: 1, commands: [] }],
      commands: [{ id: command, handler: 'word-count' }],
    });
    const receipt = { attempt: id, generation: 1, pid: 12 };
    expect(await withdrawn.start(machine, receipt)).toBe('policy-denied');
    expect(await withdrawn.start(machine, receipt)).toBe('policy-denied'); // Lost HTTP response.
    const denied = await service.status(id);
    expect(denied).toMatchObject({ state: 'failed', pid: null, result: { outcome: 'failed' } });
    // A worker which exits on the denied launch must still release the slot.
    const next = await service.submit({ command, requestKey: randomUUID(), text: 'next' });
    expect((await service.poll(machine))?.attempt).toBe(next.id);
    await withdrawn.finish(machine, denied.result); // Idempotent with a reporting worker.
    const started = { ...receipt, attempt: next.id };
    expect(await service.start(machine, started)).toBe('started');
    expect(await removed.start(machine, started)).toBe('started'); // Replay of an accepted receipt.
    await expect(removed.start(machine, { ...started, pid: 34 })).rejects.toMatchObject({ status: 409 });
    expect(await removed.authenticate(token)).toBe(machine);
    await expect(removed.poll(machine)).rejects.toMatchObject({ status: 403 });
    await removed.finish(machine, { attempt: next.id, generation: 1, outcome: 'succeeded', count: 1 });
    expect((await service.status(next.id)).state).toBe('succeeded');
  });

  it('honors a caller-supplied transaction across service calls', async () => {
    const command = randomUUID();
    const machine = randomUUID();
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const service = new HostService(pool, {
        machines: [{ id: machine, enabled: true, slots: 1, commands: [command] }],
        commands: [{ id: command, handler: 'word-count' }],
      }, db);
      const { id } = await service.submit({ command, requestKey: randomUUID(), text: 'pilot' });
      expect((await service.poll(machine))?.attempt).toBe(id);
      expect((await service.status(id)).state).toBe('reserved');
      expect((await pool.query('SELECT id FROM hc_requests WHERE id=$1', [id])).rowCount).toBe(0);
      await db.query('ROLLBACK');
      await expect(service.status(id)).rejects.toMatchObject({ status: 404 });
    } finally { await db.query('ROLLBACK'); db.release(); }
  });

  it('gives one eligible machine the lease when two poll together and records failure before launch', async () => {
    const { command, machine, second, service } = fixture();
    const { id } = await service.submit({ command, requestKey: randomUUID(), text: 'pilot' });
    const leases = await Promise.all([service.poll(machine), service.poll(second)]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    const winner = leases[0] ? machine : second;
    const failure = { attempt: id, generation: 1, outcome: 'failed', reason: 'missing dependency' };
    await service.finish(winner, failure);
    await service.finish(winner, failure);
    await expect(service.start(winner, { attempt: id, generation: 1, pid: 12 })).rejects.toMatchObject({ status: 409 });
  });
});
