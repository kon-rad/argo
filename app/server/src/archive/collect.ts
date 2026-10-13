import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// SQLite's online backup API: a consistent copy of a live WAL database, which
// a plain file copy is not. python3 is on both hosts; the sqlite3 CLI is not.
const BACKUP_PY = `import sqlite3,sys,os
os.umask(0o077)
os.makedirs(os.path.dirname(sys.argv[2]),exist_ok=True)
s=sqlite3.connect(sys.argv[1]);d=sqlite3.connect(sys.argv[2]);s.backup(d);d.close();s.close()`;

export async function snapshotSqlite(src: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  await run('python3', ['-c', BACKUP_PY, src, dest], { timeout: 120_000 });
}

// Hermes on the server: its home and the Unix user that owns it.
const REMOTE_USER = process.env.REMOTE_HERMES_USER ?? 'hermes';
// `~user`, not `~`: the remote shell runs as the ssh login, not as REMOTE_USER.
const REMOTE_HOME = process.env.REMOTE_HERMES_HOME ?? `~${REMOTE_USER}/.hermes`;
// The droplet's UFW rate-limits port 22 (6 connections / 30 s): share one connection across ssh and rsync.
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
  '-o', 'ControlMaster=auto', '-o', 'ControlPath=/tmp/sb-archive-%C', '-o', 'ControlPersist=60'];

export async function pullDroplet(destDir: string, sshHost: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const py = BACKUP_PY.replace(/'/g, `'"'"'`);
  let remoteTmp: string | null = null; // per-run 0700 dir owned by hermes; removed in finally
  try {
    const made = await run('ssh', [...SSH_OPTS, sshHost, `sudo -u ${REMOTE_USER} mktemp -d /tmp/hermes-archive.XXXXXX`], { timeout: 60_000 });
    remoteTmp = made.stdout.trim();
    if (!/^\/tmp\/hermes-archive\.[A-Za-z0-9]+$/.test(remoteTmp)) { const bad = remoteTmp; remoteTmp = null; throw new Error(`unexpected remote tmp dir: ${bad}`); }
    await run('ssh', [...SSH_OPTS, sshHost,
      `sudo -u ${REMOTE_USER} python3 -c '${py}' ${REMOTE_HOME}/state.db ${remoteTmp}/state.db`], { timeout: 180_000 });
    const rsync = (src: string, dest: string, filters: string[] = []) => run('rsync',
      ['-a', '--delete', ...filters, '-e', `ssh ${SSH_OPTS.join(' ')}`, '--rsync-path=sudo rsync', `${sshHost}:${src}`, dest],
      { timeout: 300_000 });
    await rsync(`${remoteTmp}/state.db`, join(destDir, 'state.db'));
    // One directory sync, filtered remotely: every non-zero rsync exit is a real failure (no glob-miss exit 23).
    await rsync(`${REMOTE_HOME}/`, `${destDir}/`, ['--include=logs/', '--include=logs/*.log', '--include=logs/*.log.1', '--include=memories/',
      '--include=memories/*.md', '--include=sessions/', '--include=sessions/*.json', '--exclude=*']);
  } finally {
    // The plaintext state.db copy must not outlive the run; reuses the ControlMaster connection.
    if (remoteTmp) await run('ssh', [...SSH_OPTS, sshHost, `sudo -u hermes rm -rf ${remoteTmp}`], { timeout: 60_000 }).catch(() => { /* best effort */ });
    await run('ssh', [...SSH_OPTS, '-O', 'exit', sshHost]).catch(() => { /* no master running */ });
  }
}

export async function uploadOutbox(outboxRoot: string): Promise<void> {
  const b2store = process.env.B2STORE ?? 'b2store';
  await run(b2store, ['put', join(outboxRoot, 'archives')], { timeout: 6 * 3600_000, maxBuffer: 64 * 1024 * 1024 });
}
