import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import request from 'supertest';
import { expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { codeAt, currentStep, generateSecret } from '../src/auth/totp.js';
import { runHostCommandOnce } from '../src/hosts/worker.js';

it('takes an authenticated owner request through an enrolled HTTP worker to a verified result', async () => {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'host-http-'));
  try {
    const machine = randomUUID();
    const config = join(vaultRoot, '.agents/org/config');
    for (const kind of ['machines', 'commands']) await mkdir(join(config, kind), { recursive: true });
    await writeFile(join(config, 'commands/count.yaml'), 'id: count\nhandler: word-count\n');
    await writeFile(join(config, 'machines', machine + '.yaml'),
      JSON.stringify({ id: machine, enabled: true, slots: 1, commands: ['count'] }));
    const password = randomUUID();
    const totpSecret = generateSecret();
    const origin = 'https://board.example';
    const app = createApp({ vaultRoot, modules: new Set(['host-pilot']), deployment: 'server',
      auth: { passwordHash: await hashPassword(password), totpSecret, publicOrigin: origin, secureCookie: false } });
    const api = '/api/host-pilot/';
    await request(app).post(api + 'poll').send({}).expect(401);
    await request(app).post(api + 'enrollment-codes').set('Origin', origin).send({ machine }).expect(401);
    const owner = request.agent(app);
    await owner.post('/api/auth/login').set('Origin', origin)
      .send({ password, code: codeAt(totpSecret, currentStep(Date.now())) }).expect(200);
    const preview = await owner.post(api + 'registry/preview').set('Origin', origin).expect(200);
    const apply = { baseRevision: preview.body.baseRevision, revision: preview.body.revision };
    await request(app).post(api + 'registry/apply').set('Origin', origin).send(apply).expect(401);
    const configFile = join(config, 'commands/count.yaml');
    await writeFile(configFile, 'id: count\nhandler: unknown\n');
    await owner.post(api + 'registry/apply').set('Origin', origin).send(apply).expect(400);
    await writeFile(configFile, 'id: count\nhandler: word-count\n');
    await owner.post(api + 'registry/apply').set('Origin', origin).send(apply).expect(200);
    // An unapplied edit cannot change live scheduling, even across app restarts.
    await writeFile(configFile, 'id: count\nhandler: unknown\n');
    await owner.post(api + 'registry/preview').set('Origin', origin).expect(400);
    const issued = await owner.post(api + 'enrollment-codes').set('Origin', origin).send({ machine }).expect(200);
    const enrolled = await request(app).post(api + 'enroll').send(issued.body).expect(200);
    await request(app).post(api + 'enroll').send(issued.body).expect(401);
    const input = { command: 'count', text: 'one two three', requestKey: randomUUID() };
    await request(app).post(api + 'requests').set('Origin', origin)
      .set('Authorization', 'Bearer ' + enrolled.body.token).send(input).expect(401);
    const queued = await owner.post(api + 'requests').set('Origin', origin).send(input).expect(200);
    const restarted = createApp({ vaultRoot, modules: new Set(['host-pilot']), deployment: 'server',
      auth: { passwordHash: await hashPassword(password), totpSecret, publicOrigin: origin, secureCookie: false } });
    const server = restarted.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing port');
      const url = 'http://127.0.0.1:' + address.port;
      const worker = fileURLToPath(new URL('../src/cli-host-worker.ts', import.meta.url));
      const child = promisify(execFile)(process.execPath, ['--import', 'tsx', worker, url, '--once'], {
        env: { PATH: process.env.PATH, SECONDBRAIN_HOST_STATE_DIR: join(vaultRoot, 'receipts'), SECONDBRAIN_HOST_TOKEN: enrolled.body.token },
        timeout: 15_000,
      });
      await child;
      const result = await owner.get(api + 'requests/' + queued.body.id).expect(200);
      await request(app).get(api + 'requests/by-key/' + input.requestKey).expect(401);
      const recovered = await owner.get(api + 'requests/by-key/' + input.requestKey).expect(200);
      expect(recovered.body).toEqual(result.body);
      expect(result.body).toMatchObject({ machine, state: 'succeeded', pid: child.child.pid, result: { count: 3 } });
      const inputBytes = Buffer.from('one two three');
      const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
      const binary = 'application/octet-stream';
      await owner.post(api + 'artifacts').set('Origin', origin).type(binary)
        .set('x-content-sha256', '0'.repeat(64)).send(inputBytes).expect(422);
      const object = await owner.post(api + 'artifacts').set('Origin', origin).type(binary)
        .set('x-content-sha256', hash(inputBytes)).send(inputBytes).expect(200);
      await request(app).post(api + 'artifacts').set('Origin', origin).type(binary)
        .set('x-content-sha256', hash(inputBytes)).send(inputBytes).expect(401);
      await owner.post(api + 'requests').set('Origin', origin)
        .send({ command: 'count', requestKey: randomUUID(), input: { ...object.body, id: randomUUID() } }).expect(404);
      const fileRequest = { command: 'count', requestKey: randomUUID(), input: object.body };
      const fileRun = await owner.post(api + 'requests').set('Origin', origin).send(fileRequest).expect(200);
      expect((await owner.post(api + 'requests').set('Origin', origin).send(fileRequest).expect(200)).body).toEqual(fileRun.body);
      await request(app).get(api + 'requests/' + fileRun.body.id + '/output').expect(401);
      expect(await runHostCommandOnce(url, enrolled.body.token)).toBe(true);
      const status = await owner.get(api + 'requests/' + fileRun.body.id).expect(200);
      const downloaded = await owner.get(api + 'requests/' + fileRun.body.id + '/output').expect(200);
      expect(JSON.parse(downloaded.body.toString())).toEqual({ count: 3 });
      expect(status.body.result.output).toMatchObject({ sha256: hash(downloaded.body), bytes: downloaded.body.length });
      await request(app).get(api + 'requests/' + fileRun.body.id + '/output')
        .set('Authorization', 'Bearer ' + enrolled.body.token).expect(401);
      const manual = await owner.post(api + 'requests').set('Origin', origin)
        .send({ ...fileRequest, requestKey: randomUUID() }).expect(200);
      const hostAuth = 'Bearer ' + enrolled.body.token;
      const claimed = await request(app).post(api + 'poll').set('Authorization', hostAuth).send({}).expect(200);
      const manualFence = { attempt: claimed.body.lease.attempt, generation: claimed.body.lease.generation };
      const transfer = api + 'transfers/' + manualFence.attempt;
      await request(app).get(transfer + '/2/input').set('Authorization', hostAuth).expect(404);
      await request(app).get(transfer + '/1/input').expect(401);
      await request(app).post(api + 'start').set('Authorization', hostAuth)
        .send({ ...manualFence, pid: process.pid }).expect(204);
      await request(app).post(api + 'finish').set('Authorization', hostAuth)
        .send({ ...manualFence, outcome: 'succeeded', count: 3, output: status.body.result.output }).expect(409);
      await request(app).put(transfer + '/1/output').set('Authorization', hostAuth).type(binary)
        .set('x-content-sha256', '0'.repeat(64)).send(inputBytes).expect(422);
      await request(app).post(api + 'finish').set('Authorization', hostAuth)
        .send({ ...manualFence, outcome: 'failed', reason: 'Output delivery failed' }).expect(204);
      await owner.get(api + 'requests/' + manual.body.id + '/output').expect(404);
      await request(app).get(api + 'transfers/' + fileRun.body.id + '/1/input')
        .set('authorization', 'Bearer ' + enrolled.body.token).expect(404);
      // A policy edit after the claim must take effect on another app instance before launch.
      const pending = await owner.post(api + 'requests').set('Origin', origin)
        .send({ ...input, requestKey: randomUUID() }).expect(200);
      const bearer = 'Bearer ' + enrolled.body.token;
      const reserved = await request(restarted).post(api + 'poll').set('Authorization', bearer).send({}).expect(200);
      expect(reserved.body.lease.attempt).toBe(pending.body.id);
      await writeFile(configFile, 'id: count\nhandler: word-count\n');
      await writeFile(join(config, 'machines', machine + '.yaml'),
        JSON.stringify({ id: machine, enabled: true, slots: 1, commands: [] }));
      const edited = await owner.post(api + 'registry/preview').set('Origin', origin).expect(200);
      await owner.post(api + 'registry/apply').set('Origin', origin)
        .send({ baseRevision: edited.body.baseRevision, revision: edited.body.revision }).expect(200);
      const receipt = { attempt: pending.body.id, generation: reserved.body.lease.generation, pid: 123 };
      await request(restarted).post(api + 'start').set('Authorization', bearer).send(receipt).expect(412);
      const denied = await owner.get(api + 'requests/' + pending.body.id).expect(200);
      expect(denied.body).toMatchObject({ state: 'failed', pid: null, result: { outcome: 'failed' } });
      // An upgrading pilot can already have live credentials and history before its first apply.
      await pool.query('UPDATE hc_registry_head SET revision=NULL');
      await owner.get(api + 'requests/' + queued.body.id).expect(200);
      await owner.post(api + 'revoke').set('Origin', origin).send({ machine }).expect(204);
      const reapply = await owner.post(api + 'registry/preview').set('Origin', origin).expect(200);
      await owner.post(api + 'registry/apply').set('Origin', origin)
        .send({ baseRevision: null, revision: reapply.body.revision }).expect(200);
      await expect(runHostCommandOnce(url, enrolled.body.token)).rejects.toThrow('401');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally { await rm(vaultRoot, { recursive: true, force: true }); }
});

it('keeps the app available when the private registry is missing', async () => {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'empty-host-config-'));
  try {
    const app = createApp({ vaultRoot, modules: new Set(['host-pilot']), deployment: 'local' });
    await request(app).get('/api/auth/me').expect(200);
    await request(app).post('/api/host-pilot/poll').send({}).expect(401);
  } finally { await rm(vaultRoot, { recursive: true, force: true }); }
});
