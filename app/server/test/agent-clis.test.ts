import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createCard, createToken } from '../src/board.js';
import { checkAgentClis } from '../src/doctor.js';
import { agentClis, agentClisJson } from '../src/features/registry.js';
import { readBoardEnv, remoteDoor, remoteMain } from '../src/features/board/cli-remote.js';
import { importOrg } from '../src/org.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

/**
 * The agent CLIs on a client machine (secondbrain-vault clis, tools/sbclis.py): the one setup command, then
 * cli-board over HTTPS with only BOARD_URL and BOARD_TOKEN from the vault .env, and every other wrapper the
 * manifests name as a one-line server-only notice. The commands run in child processes with a scrubbed
 * environment (a temp HOME, no DATABASE_URL, no PG*, no server env), so nothing of the engine's build or
 * database reaches them.
 */

const ENGINE = resolve(import.meta.dirname, '..', '..', '..');
const SBVAULT = join(ENGINE, 'tools', 'sbvault.py');
const NODE_DIR = dirname(process.execPath);

interface Run { code: number; stdout: string; stderr: string }
const sh = (cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<Run> =>
  new Promise((done) => {
    execFile(cmd, args, { env, cwd, timeout: 120_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      done({ code, stdout, stderr });
    });
  });

describe('agent CLIs on a client machine', () => {
  let root: string;
  let vault: string;
  let bin: string;
  let data: string;
  let server: Server;
  let url: string;
  let token: string;
  /** What a laptop has: a HOME, node and the system tools on PATH. No database, no server env, no BOARD_* in env. */
  let clientEnv: NodeJS.ProcessEnv;
  const install = (...extra: string[]): Promise<Run> => sh('python3', [SBVAULT, '--vault', vault, 'clis', 'install', '--bin', bin, ...extra], clientEnv);

  beforeAll(async () => {
    await truncateAll();
    await importOrg({
      version: 'clis-1', company: 'Co', ceo: 'owner',
      agents: { owner: { runtime: 'human', role: 'CEO', channels: ['*'] }, rune: { role: 'Engineer', team: 'eng', reports_to: 'owner' } },
      teams: { eng: { name: 'Eng', lead: 'rune' } }, channels: { 'all-hands': { members: '*' } },
    });
    await createCard('owner', { title: 'Visible from a laptop', assignee: 'rune' });
    token = (await createToken('rune', 'laptop')).token;
    server = createServer(createApp({ modules: ALL_MODULES, board: { owner: 'owner' } }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    root = realpathSync(mkdtempSync(join(tmpdir(), 'sb-clis-')));   // macOS: /var is /private/var
    vault = join(root, 'vault');
    bin = join(root, 'bin');
    data = join(root, 'data');
    mkdirSync(vault, { recursive: true });
    // A vault .env with other keys around the two the door reads, one of them quoted.
    writeFileSync(join(vault, '.env'), `# my vault\nDATABASE_URL=postgres://nowhere.invalid:1/none\nBOARD_URL="${url}"\nBOARD_TOKEN=${token}\nOTHER=x\n`);
    clientEnv = { HOME: join(root, 'home'), PATH: [bin, NODE_DIR, '/usr/bin', '/bin'].join(':'), SECONDBRAIN_CLI_HOME: data, LANG: 'C' };
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  it('bin/agent-clis.json is the manifests\' wrapper table (regenerate: secondbrain features agent-clis > app/bin/agent-clis.json)', () => {
    expect(readFileSync(join(ENGINE, 'app', 'bin', 'agent-clis.json'), 'utf8')).toBe(agentClisJson());
    const doors = Object.fromEntries(agentClis().map((c) => [c.name, c.door]));
    expect(doors).toMatchObject({ 'cli-board': 'https', 'cli-org': 'server-only', 'cli-projects': 'server-only' });
  });

  it('installs every wrapper with one command, and a re-run changes nothing', async () => {
    const first = await install();
    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);
    const names = agentClis().map((c) => c.name);
    expect(readdirSync(bin).sort()).toEqual([...names].sort());
    expect(first.stdout).toContain(`agent CLIs: ${names.length + 1} changed`);   // the wrappers plus the bundle
    const bundle = join(data, 'cli-board.mjs');
    expect(existsSync(bundle)).toBe(true);
    // The bundle is self-contained: no database client, no server env file, nothing under the app.
    const code = readFileSync(bundle, 'utf8');
    expect(code).not.toMatch(/from ['"]pg['"]|\/etc\/secondbrain\/env|server\/dist/);
    // The token stays in the vault .env: neither the output nor any written file holds it.
    expect(first.stdout).not.toContain(token);
    for (const n of names) expect(readFileSync(join(bin, n), 'utf8')).not.toContain(token);

    const snap = (): string[] => [...names.map((n) => join(bin, n)), bundle].map((p) => `${p} ${statSync(p).mtimeMs} ${statSync(p).mode} ${readFileSync(p, 'utf8').length}`);
    const before = snap();
    const again = await install();
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('agent CLIs: 0 changed');
    expect(again.stdout).toContain('bundle ' + bundle + ': unchanged');
    expect(snap()).toEqual(before);
  });

  it('cli-board list --json returns the cards with only BOARD_URL and BOARD_TOKEN from the vault .env', async () => {
    const r = await sh('cli-board', ['list', '--json'], clientEnv, root);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    const cards = JSON.parse(r.stdout) as { title: string; assignee: string }[];
    expect(cards.map((c) => c.title)).toContain('Visible from a laptop');
    // The environment wins over the file: a wrong token there is a 401, one line, no stack trace.
    const bad = await sh('cli-board', ['list'], { ...clientEnv, BOARD_TOKEN: 'sbb_wrong_wrong_wrong_wrong' }, root);
    expect(bad.code).toBe(1);
    expect(bad.stderr.trim().split('\n')).toHaveLength(1);
    expect(bad.stderr).toMatch(/^board 401/);
  });

  it('cli-org and cli-projects exit non-zero with one server-only line', async () => {
    for (const name of ['cli-org', 'cli-projects']) {
      const r = await sh(name, ['list'], clientEnv, root);
      expect(r.code).toBe(69);
      expect(r.stdout).toBe('');
      const lines = r.stderr.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(new RegExp(`^${name} is server-only: `));
    }
  });

  it('cli-board without the keys, and an unreachable server, each say one line', async () => {
    const empty = join(root, 'empty.env');
    writeFileSync(empty, 'OTHER=1\n');
    const bundle = join(data, 'cli-board.mjs');
    const none = await sh(process.execPath, ['--no-warnings', bundle, 'list'], { ...clientEnv, SB_VAULT_ENV: empty });
    expect(none.code).toBe(1);
    expect(none.stderr.trim()).toBe(`cli-board: BOARD_URL and BOARD_TOKEN not set in the environment or ${empty}; add them to the vault .env (docs/kanban-board.md, door 2)`);
    const down = await sh(process.execPath, ['--no-warnings', bundle, 'list'], { ...clientEnv, BOARD_URL: 'http://127.0.0.1:9', BOARD_TOKEN: 'sbb_x' });
    expect(down.code).toBe(1);
    expect(down.stderr.trim()).toMatch(/^cli-board: cannot reach http:\/\/127\.0\.0\.1:9 \(/);
    const tok = await sh(process.execPath, ['--no-warnings', bundle, 'token', 'list'], clientEnv);
    expect(tok.stderr.trim()).toBe('cli-board token needs the database door: run it on the server');
  });

  it('doctor says installed / server-only / missing per wrapper', () => {
    const by = (checks: ReturnType<typeof checkAgentClis>): Record<string, string> => Object.fromEntries(checks.map((c) => [c.name, `${c.ok}|${c.detail}`]));
    const here = by(checkAgentClis({ binDir: bin, path: '', boardDoor: true }));
    expect(here['cli:cli-board']).toMatch(/^true\|installed \(HTTPS door\) at /);
    expect(here['cli:cli-org']).toMatch(/^true\|server-only on this machine/);
    const noKeys = by(checkAgentClis({ binDir: bin, path: '', boardDoor: false }));
    expect(noKeys['cli:cli-board']).toMatch(/^false\|installed \(HTTPS\) .* BOARD_URL and BOARD_TOKEN are not set/);
    const bare = checkAgentClis({ binDir: join(root, 'nothing'), path: '', boardDoor: true });
    expect(bare.every((c) => !c.ok && !c.critical && c.detail === 'missing on this machine')).toBe(true);
    // A wrapper not written by the tool (the server's deploy.sh one) counts as installed.
    const server = join(root, 'server-bin');
    mkdirSync(server);
    writeFileSync(join(server, 'cli-org'), '#!/usr/bin/env bash\nexec node x "$@"\n');
    expect(by(checkAgentClis({ binDir: join(root, 'nothing'), path: server, boardDoor: true }))['cli:cli-org']).toBe(`true|installed at ${join(server, 'cli-org')}`);
  });

  it('never overwrites or removes a file it did not write, and uninstall removes the rest', async () => {
    const mine = '#!/bin/sh\necho my own cli-memory\n';
    rmSync(join(bin, 'cli-memory'));
    writeFileSync(join(bin, 'cli-memory'), mine);
    chmodSync(join(bin, 'cli-memory'), 0o755);
    const r = await install();
    expect(r.stdout).toContain(`kept ${join(bin, 'cli-memory')}: not written by secondbrain-vault, left alone`);
    expect(readFileSync(join(bin, 'cli-memory'), 'utf8')).toBe(mine);
    const status = await sh('python3', [SBVAULT, '--vault', vault, 'clis', 'status', '--bin', bin, '--json'], clientEnv);
    expect(status.code).toBe(0);
    const states = Object.fromEntries((JSON.parse(status.stdout) as { name: string; state: string }[]).map((s) => [s.name, s.state]));
    expect(states).toMatchObject({ 'cli-board': 'installed', 'cli-org': 'server-only', 'cli-memory': 'installed' });

    const u = await sh('python3', [SBVAULT, '--vault', vault, 'clis', 'uninstall', '--bin', bin], clientEnv);
    expect(u.code).toBe(0);
    expect(readdirSync(bin)).toEqual(['cli-memory']);
    expect(readFileSync(join(bin, 'cli-memory'), 'utf8')).toBe(mine);
    expect(existsSync(join(data, 'cli-board.mjs'))).toBe(false);
    expect(readFileSync(join(vault, '.env'), 'utf8')).toContain(token);   // the vault .env is untouched
  });
});

describe('cli-remote (the bundle entry) in process', () => {
  it('reads only the two door keys from a dotenv file, quotes stripped, environment first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, "export BOARD_URL='https://board.example.com/'\nBOARD_TOKEN=abc # trailing\nAUTH_PASSWORD_HASH=$2b$x\n");
    expect(readBoardEnv(file)).toEqual({ BOARD_URL: 'https://board.example.com/', BOARD_TOKEN: 'abc' });
    expect(remoteDoor({ SB_VAULT_ENV: file })).toEqual({ url: 'https://board.example.com', token: 'abc' });
    expect(remoteDoor({ SB_VAULT_ENV: file, BOARD_TOKEN: 'env' })).toEqual({ url: 'https://board.example.com', token: 'env' });
    expect(remoteDoor({})).toEqual({ problem: expect.stringMatching(/^cli-board: BOARD_URL and BOARD_TOKEN not set in the environment;/) });
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints the usage for help and rejects an unknown flag before any request', async () => {
    const lines: string[] = [];
    expect(await remoteMain(['help'], (s) => lines.push(s), {})).toBe(0);
    expect(lines[0]).toMatch(/^cli-board <command>/);
    await expect(remoteMain(['list', '--nope'], () => {}, {})).rejects.toThrow(/unknown flag --nope/);
  });
});
