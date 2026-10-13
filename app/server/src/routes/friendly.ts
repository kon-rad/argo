import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Router } from 'express';
import { log } from '../logger.js';
import { wrap } from './http.js';

export interface FriendlyOptions {
  /** start-reachy.sh: brings up the Reachy daemon, the sidecar and the UI. */
  script: string;
  /** Where the script's output goes; the launch is detached, so no one else sees it. */
  logFile: string;
  /** The Friendly web UI. Listening on it is what "running" means. */
  port?: number;
  /** Overridden in tests so nothing actually starts a robot. */
  spawnFn?: typeof spawn;
}

/** True once something accepts a TCP connection on the port. */
export function isListening(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (up: boolean): void => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * The environment the script sees: a clean one, not a copy of this server's.
 *
 * Ours carries PORT=5123 from the launcher and every key dotenv read from the
 * vault .env. Friendly loads its own .env with --env-file, which never
 * overrides a variable that is already set — so an inherited copy made it bind
 * Second Brain's port and would have swapped in the wrong API key.
 *
 * PATH is rebuilt too: a server started from Finder or the .app has launchd's
 * bare PATH, with no ~/.local/bin, which is where `reachy-mini-daemon` lives.
 */
export function launchEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (parent[key] !== undefined) env[key] = parent[key];

  const extra = [dirname(process.execPath), join(homedir(), '.local', 'bin'), '/opt/homebrew/bin'];
  const current = (parent.PATH ?? '').split(':').filter(Boolean);
  env.PATH = [...extra.filter((d) => !current.includes(d)), ...current].join(':');
  return env;
}

export function friendlyRouter(opts: FriendlyOptions): Router {
  const router = Router();
  const port = opts.port ?? 7500;
  const spawnFn = opts.spawnFn ?? spawn;
  let child: ChildProcess | null = null;

  const launching = (): boolean => child !== null && child.exitCode === null && child.signalCode === null;

  router.get(
    '/status',
    wrap(async (_req, res) => {
      const running = await isListening(port);
      res.json({ status: running ? 'running' : launching() ? 'starting' : 'stopped', port });
    }),
  );

  router.post(
    '/start',
    wrap(async (_req, res) => {
      if (await isListening(port)) {
        res.json({ status: 'running', port });
        return;
      }
      // The script kills anything on the robot's ports before it starts, so a
      // second launch mid-boot would tear down the first one.
      if (launching()) {
        res.status(202).json({ status: 'starting', port });
        return;
      }
      if (!existsSync(opts.script)) {
        res.status(500).json({ error: { message: `launch script not found: ${opts.script}` } });
        return;
      }

      mkdirSync(dirname(opts.logFile), { recursive: true });
      const out = openSync(opts.logFile, 'a');
      // Detached, so the robot keeps running if Second Brain is restarted.
      child = spawnFn('bash', [opts.script], {
        cwd: dirname(opts.script),
        detached: true,
        stdio: ['ignore', out, out],
        env: launchEnv(),
      });
      child.on('error', (err) => log.error('friendly launch failed:', err));
      child.on('exit', (code) => {
        if (code) log.warn(`friendly launch script exited ${code}; see ${opts.logFile}`);
      });
      child.unref();
      log.info(`launching Friendly (pid ${child.pid}), log: ${opts.logFile}`);
      res.status(202).json({ status: 'starting', port });
    }),
  );

  return router;
}
