import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import request from 'supertest';
import { expect, it } from 'vitest';
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
    const issued = await owner.post(api + 'enrollment-codes').set('Origin', origin).send({ machine }).expect(200);
    const enrolled = await request(app).post(api + 'enroll').send(issued.body).expect(200);
    await request(app).post(api + 'enroll').send(issued.body).expect(401);
    const input = { command: 'count', text: 'one two three', requestKey: randomUUID() };
    await request(app).post(api + 'requests').set('Origin', origin)
      .set('Authorization', 'Bearer ' + enrolled.body.token).send(input).expect(401);
    const queued = await owner.post(api + 'requests').set('Origin', origin).send(input).expect(200);
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing port');
      const url = 'http://127.0.0.1:' + address.port;
      const worker = fileURLToPath(new URL('../src/cli-host-worker.ts', import.meta.url));
      const child = promisify(execFile)(process.execPath, ['--import', 'tsx', worker, url, '--once'], {
        env: { PATH: process.env.PATH, SECONDBRAIN_HOST_TOKEN: enrolled.body.token },
        timeout: 15_000,
      });
      await child;
      const result = await owner.get(api + 'requests/' + queued.body.id).expect(200);
      expect(result.body).toMatchObject({ machine, state: 'succeeded', pid: child.child.pid, result: { count: 3 } });
      await owner.post(api + 'revoke').set('Origin', origin).send({ machine }).expect(204);
      await expect(runHostCommandOnce(url, enrolled.body.token)).rejects.toThrow('401');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally { await rm(vaultRoot, { recursive: true, force: true }); }
});

it('keeps the app available when the private registry is missing', async () => {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'empty-host-config-'));
  try {
    const app = createApp({ vaultRoot, modules: new Set(['host-pilot']), deployment: 'local' });
    await request(app).get('/api/auth/me').expect(200);
    await request(app).post('/api/host-pilot/poll').send({}).expect(503);
  } finally { await rm(vaultRoot, { recursive: true, force: true }); }
});
