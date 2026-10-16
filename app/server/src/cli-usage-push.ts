// Laptop -> server, every 15 minutes from the LaunchAgent bin/install-usage-push-mac.sh installs. One SSH
// connection per run, to USAGE_PUSH_HOST (an ~/.ssh/config alias with root on the server).
// The cursor only moves when the server confirms the whole import (exit 0 or 2 = imported with some bad lines).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildPush, type PushCursor } from './usage/push.js';

const home = homedir();
const stateDir = process.env.USAGE_PUSH_STATE ?? join(home, '.local', 'share', 'secondbrain');
const cursorFile = join(stateDir, 'usage-push-cursor.json');
const sshHost = process.env.USAGE_PUSH_HOST ?? '';
if (!sshHost) { console.error('usage-push: set USAGE_PUSH_HOST (ssh destination of the server)'); process.exit(1); }
// This machine's slug in usage_hosts ('mac' by default; register others in usage_hosts first).
const usageHost = process.env.USAGE_HOST ?? 'mac';
if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(usageHost)) { console.error(`usage-push: bad USAGE_HOST ${usageHost}`); process.exit(1); }

let cursor: PushCursor = { files: {} };
try {
  if (existsSync(cursorFile)) cursor = JSON.parse(readFileSync(cursorFile, 'utf8')) as PushCursor;
  if (!cursor || typeof cursor.files !== 'object' || !cursor.files) cursor = { files: {} };
} catch {
  cursor = { files: {} }; // corrupt cursor: resend from the start, the importer dedupes
}
const push = buildPush({
  claudeProjectsDir: process.env.CLAUDE_PROJECTS_DIR ?? join(home, '.claude', 'projects'),
  planLog: join(stateDir, 'plan-usage.ndjson'),
  maxBytes: Number(process.env.USAGE_PUSH_MAX_BYTES ?? 20_000_000),
  host: usageHost,
}, cursor);

if (!push.lines.length) {
  console.log(`${new Date().toISOString()} usage-push: nothing new`);
  process.exit(0);
}

const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', sshHost, `/usr/local/bin/secondbrain-usage-import ${usageHost}`],
  { stdio: ['pipe', 'inherit', 'inherit'] });
for (const line of push.lines) child.stdin.write(line + '\n');
child.stdin.on('error', () => { /* surfaced by the close/error handlers */ });
child.stdin.end();
child.on('error', (err) => {
  console.error(`${new Date().toISOString()} usage-push: could not start ssh: ${err.message}; cursor kept`);
  process.exit(1);
});
child.on('close', (code) => {
  if (code === 0 || code === 2) {
    mkdirSync(dirname(cursorFile), { recursive: true });
    writeFileSync(cursorFile + '.tmp', JSON.stringify(push.next));
    renameSync(cursorFile + '.tmp', cursorFile);
    console.log(`${new Date().toISOString()} usage-push: ${push.lines.length} lines, ${push.bytes} bytes sent`);
    process.exit(0);
  }
  console.error(`${new Date().toISOString()} usage-push: ssh/import exited ${code}; cursor kept, will resend`);
  process.exit(1);
});
