import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { machineDefinition } from '@secondbrain/contracts/hosts';
import { z } from 'zod';
import { workerOrigin } from './worker.js';

const identity = z.strictObject({
  machine: machineDefinition.shape.id, token: z.string().min(1).max(4096),
});
const enrollment = identity.extend({ origin: z.string() });
export const workerLabel = 'org.secondbrain.host-worker';
export const unit = 'secondbrain-host-worker.service';

export const stateDirectory = (home: string) => join(home, '.config', 'secondbrain', 'host-worker');

function privateDirectory(home: string, create: boolean): string {
  const dir = stateDirectory(home);
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) {
    throw new Error('Host enrollment directory requires private owner permissions (0700)');
  }
  return dir;
}

export async function enrollWorker(home: string, origin: string, code: string, send: typeof fetch = fetch) {
  const server = workerOrigin(origin);
  if (!code || code.length > 256) throw new Error('Expected one enrollment code on stdin');
  const file = join(privateDirectory(home, true), 'enrollment.json');
  // Reserve before consuming a one-use code. Only this process may write the new identity.
  const fd = openSync(file, 'wx', 0o600);
  try {
    const response = await send(new URL('/api/host-pilot/enroll', server), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    });
    if (!response.ok) throw new Error('Enrollment returned HTTP ' + response.status);
    const result = identity.safeParse(await response.json().catch(() => null));
    if (!result.success) throw new Error('Invalid enrollment response');
    writeFileSync(fd, JSON.stringify({ ...result.data, origin: server.origin }) + '\n');
    fsyncSync(fd);
    return result.data.machine;
  } catch (error) {
    unlinkSync(file);
    throw error;
  } finally { closeSync(fd); }
}

export function readEnrollment(home: string) {
  const file = join(privateDirectory(home, false), 'enrollment.json');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 8192) {
      throw new Error('Host enrollment file requires private owner permissions (0600)');
    }
    let record: unknown;
    try { record = JSON.parse(readFileSync(fd, 'utf8')); }
    catch { throw new Error('Invalid local host enrollment'); }
    const parsed = enrollment.safeParse(record);
    if (!parsed.success) throw new Error('Invalid local host enrollment');
    workerOrigin(parsed.data.origin);
    return parsed.data;
  } finally { closeSync(fd); }
}

function xml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
function systemdArg(value: string) {
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
}
export function serviceDefinition(platform: string, home: string, node: string, entry: string) {
  for (const path of [home, node, entry]) {
    if (!path.startsWith('/') || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Expected an absolute service path without control characters');
  }
  const args = [node, entry, '--enrolled'];
  if (platform === 'darwin') {
    const log = xml(join(stateDirectory(home), 'worker.log'));
    return {
      file: join(home, 'Library', 'LaunchAgents', workerLabel + '.plist'),
      contents: '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n' +
        '<key>Label</key><string>' + workerLabel + '</string>\n<key>ProgramArguments</key><array>' +
        args.map(arg => '<string>' + xml(arg) + '</string>').join('') + '</array>\n' +
        '<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n' +
        '<key>ThrottleInterval</key><integer>30</integer>\n<key>ExitTimeOut</key><integer>240</integer>\n' +
        '<key>StandardOutPath</key><string>' + log + '</string>\n' +
        '<key>StandardErrorPath</key><string>' + log + '</string>\n</dict></plist>\n',
    };
  }
  if (platform === 'linux') {
    return {
      file: join(home, '.config', 'systemd', 'user', unit),
      contents: '[Unit]\nDescription=Second Brain host worker\n\n[Service]\nExecStart=' +
        args.map(systemdArg).join(' ') + '\nRestart=on-failure\nRestartSec=30\nTimeoutStopSec=240\nUMask=0077\n' +
        '\n[Install]\nWantedBy=default.target\n',
    };
  }
  throw new Error('Host service installation requires macOS or Linux');
}
