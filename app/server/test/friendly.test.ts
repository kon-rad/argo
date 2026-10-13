import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { launchEnv } from '../src/routes/friendly.js';

let dir: string;
let script: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sb-friendly-'));
  script = join(dir, 'start-reachy.sh');
  await writeFile(script, '#!/usr/bin/env bash\n');
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** Records launches instead of booting a robot; the fake child never exits. */
function fakeSpawn() {
  const calls: { cmd: string; args: readonly string[]; path: string | undefined }[] = [];
  const fn = ((cmd: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args, path: opts.env?.PATH });
    return Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      unref() {},
    });
  }) as unknown as typeof spawn;
  return { fn, calls };
}

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe('/api/friendly', () => {
  it('launches the script once, and reports starting until the UI listens', async () => {
    const port = await freePort();
    const spawner = fakeSpawn();
    const app = createApp({
      friendly: { script, logFile: join(dir, 'launch.log'), port, spawnFn: spawner.fn },
    });

    expect((await request(app).get('/api/friendly/status')).body.status).toBe('stopped');

    const first = await request(app).post('/api/friendly/start');
    expect(first.status).toBe(202);
    expect(first.body.status).toBe('starting');
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]!.args).toEqual([script]);
    // The daemon is called by name from ~/.local/bin, which launchd never puts on PATH.
    expect(spawner.calls[0]!.path).toContain('.local/bin');

    // A second click mid-boot must not relaunch: the script kills the ports first.
    await request(app).post('/api/friendly/start');
    expect(spawner.calls).toHaveLength(1);

    const ui: Server = createServer();
    await new Promise<void>((r) => ui.listen(port, '127.0.0.1', r));
    try {
      expect((await request(app).get('/api/friendly/status')).body.status).toBe('running');
      const again = await request(app).post('/api/friendly/start');
      expect(again.status).toBe(200);
      expect(again.body.status).toBe('running');
    } finally {
      await new Promise<void>((r) => ui.close(() => r()));
    }
  });

  it('fails loudly when the launch script is missing', async () => {
    const spawner = fakeSpawn();
    const app = createApp({
      friendly: {
        script: join(dir, 'nope.sh'),
        logFile: join(dir, 'launch.log'),
        port: await freePort(),
        spawnFn: spawner.fn,
      },
    });
    const res = await request(app).post('/api/friendly/start');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toMatch(/not found/);
    expect(spawner.calls).toHaveLength(0);
  });

  it("does not hand this server's own config to the robot", () => {
    const env = launchEnv({ HOME: '/h', PATH: '/usr/bin', PORT: '5123', TOGETHER_API_KEY: 'vault-key' });
    // Friendly's --env-file never overrides an inherited variable.
    expect(env.PORT).toBeUndefined();
    expect(env.TOGETHER_API_KEY).toBeUndefined();
    expect(env.HOME).toBe('/h');
    expect(env.PATH).toMatch(/\.local\/bin.*:\/usr\/bin$/);
  });
});
