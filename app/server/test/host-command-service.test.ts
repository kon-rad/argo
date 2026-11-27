import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { HostService } from '../src/hosts/service.js';

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
