import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineDefinition } from '@secondbrain/contracts/hosts';
import { enrollWorker, readEnrollment, serviceDefinition, workerLabel, unit, stateDirectory } from './hosts/lifecycle.js';
import { workerOrigin } from './hosts/worker.js';

const usage = 'Usage: secondbrain host enroll <origin> | install | start | status | logs | drain | stop | revoke <origin> <machine>';
async function secretFromStdin(max: number) {
  if (process.stdin.isTTY) throw new Error('Provide the credential through a private stdin pipe');
  let value = '';
  for await (const chunk of process.stdin.setEncoding('utf8')) {
    value += chunk;
    if (value.length > max + 2) throw new Error('Input is too long');
  }
  value = value.trim();
  if (!value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Expected one nonempty credential on stdin');
  return value;
}

function run(cmd: string, args: string[]) {
  const child = spawnSync(cmd, args, { stdio: 'inherit' });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(cmd + ' exited with ' + (child.status ?? child.signal));
}

async function main() {
  const [action, origin, machine, ...extra] = process.argv.slice(2);
  const home = homedir();
  if (action === 'enroll' && origin && !machine) {
    console.log('Enrolled ' + await enrollWorker(home, origin, await secretFromStdin(256)));
    return;
  }
  if (action === 'revoke' && origin && machine && !extra.length) {
    const target = workerOrigin(origin);
    machineDefinition.shape.id.parse(machine);
    const response = await fetch(new URL('/api/host-pilot/revoke', target), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Cookie: await secretFromStdin(8192), Origin: target.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine }),
    });
    if (!response.ok) throw new Error('Owner revocation returned HTTP ' + response.status);
    console.log('Revoked ' + machine);
    return;
  }
  if (!action || origin || !['install', 'start', 'status', 'logs', 'drain', 'stop'].includes(action)) throw new Error(usage);
  const entry = fileURLToPath(new URL('./cli-host-worker.js', import.meta.url));
  const service = serviceDefinition(process.platform, home, process.execPath, entry);
  if (action === 'install') {
    readEnrollment(home);
    mkdirSync(dirname(service.file), { recursive: true });
    const staging = mkdtempSync(join(dirname(service.file), '.host-worker-'));
    try {
      const file = join(staging, 'service');
      writeFileSync(file, service.contents, { mode: 0o600 });
      renameSync(file, service.file);
    } finally { rmSync(staging, { recursive: true, force: true }); }
    if (process.platform === 'linux') run('systemctl', ['--user', 'daemon-reload']);
    console.log(service.file);
    return;
  }
  if (process.platform === 'darwin') {
    const domain = 'gui/' + process.getuid!();
    const target = domain + '/' + workerLabel;
    const log = join(stateDirectory(home), 'worker.log');
    if (action === 'logs') return run('/usr/bin/tail', ['-n', '100', log]);
    const state = spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8' });
    if (state.error) throw state.error;
    if (state.status && !state.stderr.includes('Could not find service')) throw new Error(state.stderr.trim());
    if (action === 'status') {
      if (state.status) console.log(existsSync(service.file) ? 'installed, stopped' : 'not installed');
      else for (const line of state.stdout.split('\n')) {
        if (/^\t(state|pid|last exit code) = /.test(line)) console.log(line.trim());
      }
      return;
    }
    if (action === 'start') {
      if (!existsSync(service.file)) throw new Error('Install the host service first');
      run('/bin/launchctl', ['enable', target]);
      if (state.status) run('/bin/launchctl', ['bootstrap', domain, service.file]);
      else run('/bin/launchctl', ['kickstart', target]);
    } else {
      run('/bin/launchctl', ['disable', target]);
      if (!state.status) run('/bin/launchctl', ['bootout', target]);
    }
    return;
  }
  if (action === 'logs') return run('journalctl', ['--user', '--unit', unit, '-n', '100', '--no-pager']);
  if (action === 'status') return run('systemctl', ['--user', 'show', unit, '--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus,UnitFileState']);
  run('systemctl', ['--user', action === 'start' ? 'enable' : 'disable', '--now', unit]);
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Host lifecycle failed');
  process.exitCode = 1;
});
