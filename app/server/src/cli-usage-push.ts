import { superviseSelf } from './usage/supervise.js';
import { fileURLToPath } from 'node:url';
// Laptop -> server, every minute from the LaunchAgent bin/install-usage-push-mac.sh installs. One SSH
// connection per run, to USAGE_PUSH_HOST (an ~/.ssh/config alias with root on the server).
// The cursor moves only after a complete versioned acknowledgement (including durable quarantine).
import { measureJsonl, combineMeasurements } from './usage/sourceHealth.js';
import { fingerprintOf } from './archive/stage.js';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runUpload } from './usage/upload.js';
import type { CollectionHealth } from './usage/health-wire.js';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { walkFiles } from './usage/walkFiles.js';
import { buildPush, type PushCursor } from './usage/push.js';
// Standalone installed collector: process environment only, never a vault .env.
const supervisorCode = await superviseSelf(fileURLToPath(import.meta.url), 600_000, true);
if (supervisorCode !== null) process.exit(supervisorCode);

const env = process.env;
const budget = (key: string, fallback: number, ceiling: number) => {
  const n = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(n) || n <= 0 || n > ceiling) throw new Error(`invalid ${key}`);
  return n;
};

const home = homedir();
const stateDir = env.USAGE_PUSH_STATE ?? join(home, '.local', 'share', 'secondbrain');
const cursorFile = join(stateDir, 'usage-push-cursor.json');
const zenSessionsDir = env.ZEN_SESSIONS_DIR ?? (env.VAULT_ROOT ? join(env.VAULT_ROOT, '.zen', 'sessions') : null);
if (process.argv.includes('--doctor')) {
  const dir = join(env.CODEX_HOME ?? join(home, '.codex'), 'sessions');
  try {
    const n = walkFiles(dir).filter(p => p.endsWith('.jsonl')).length;
    console.log(`Codex conversations: ${!existsSync(dir) ? 'sessions directory missing; start a Codex session first' : n ? `${n} JSONL files found` : 'sessions directory empty; start a Codex session first'}`);
    console.log(`Upload destination: ${env.USAGE_PUSH_HOST ? 'configured (SSH authentication checked only on push)' : 'missing; set USAGE_PUSH_HOST'}`);
    console.log(`Host identity: ${env.USAGE_HOST ? 'configured' : 'missing; set a unique USAGE_HOST per machine'}`);
    console.log(`Lock: ${existsSync(join(stateDir, 'usage-push.lock', 'pid')) ? readFileSync(join(stateDir, 'usage-push.lock', 'pid'), 'utf8').trim() : 'none'}`);
    console.log(`Cursor: ${existsSync(cursorFile) ? 'present' : 'new; first upload includes history'}`);
    console.log('Quota panels are configured separately from conversation ingestion.');
    process.exit(env.USAGE_PUSH_HOST && env.USAGE_HOST ? 0 : 1);
  } catch { console.error('usage-push: cannot scan sessions; check directory permissions'); process.exit(1); }
}
const sshHost = env.USAGE_PUSH_HOST ?? '';
if (!/^[a-zA-Z0-9][a-zA-Z0-9@._:-]*$/.test(sshHost)) { console.error('usage-push: set USAGE_PUSH_HOST (ssh destination of the server)'); process.exit(1); }
// This machine's slug in usage_hosts (the authenticated importer registers new slugs).
const usageHost = env.USAGE_HOST ?? 'mac';
if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(usageHost)) { console.error(`usage-push: bad USAGE_HOST ${usageHost}`); process.exit(1); }

let cursor: PushCursor = { files: {} };
try {
  if (existsSync(cursorFile)) cursor = JSON.parse(readFileSync(cursorFile, 'utf8')) as PushCursor;
  if (!cursor || typeof cursor.files !== 'object' || !cursor.files) cursor = { files: {} };
} catch {
  cursor = { files: {} }; // corrupt cursor: resend from the start, the importer dedupes
}
mkdirSync(stateDir, { recursive: true });
const lock = join(stateDir, 'usage-push.lock');
try { mkdirSync(lock); } catch {
  const pid = Number(existsSync(join(lock, 'pid')) ? readFileSync(join(lock, 'pid'), 'utf8') : NaN);
  // A lock without a known dead owner needs operator inspection, never automatic deletion.
  let dead = false;
  if (pid > 0) { try { process.kill(pid, 0); } catch (err) { dead = (err as NodeJS.ErrnoException).code === 'ESRCH'; } }
  if (!dead) { console.error('usage-push: locked; inspect owner before removing lock'); process.exit(1); }
  const stale = `${lock}.stale-${process.pid}`;
  try { renameSync(lock, stale); rmSync(stale, { recursive: true }); mkdirSync(lock); }
  catch { console.error('usage-push: lock ownership changed; retry later'); process.exit(1); }
}
writeFileSync(join(lock, 'pid'), String(process.pid));
const save = (value: PushCursor) => {
  writeFileSync(cursorFile + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(cursorFile + '.tmp', cursorFile);
};
const startedAt = new Date().toISOString();
const backfill = !Object.keys(cursor.files).length;
cursor.instanceId ??= randomUUID();
cursor.attemptSeq = (cursor.attemptSeq ?? 0) + 1;
// Persist attempt identity before transport; source offsets stay at their acknowledged values.
try {
  save(cursor);
  console.log(`${startedAt} usage-push stage=collect-start mode=${backfill ? 'backfill' : 'tick'}`);
  const timedOut = process.argv.includes('--health-timeout');
  const push = timedOut ? { lines: [] as string[], next: cursor, bytes: 0 } : buildPush({
    claudeProjectsDir: env.CLAUDE_PROJECTS_DIR ?? join(home, '.claude', 'projects'),
    codexSessionsDir: join(env.CODEX_HOME ?? join(home, '.codex'), 'sessions'),
    // zen-agent chats on this machine: the vault's .zen/sessions is gitignored, so they reach the server only from here.
    zenSessionsDir,
    planLog: join(stateDir, 'plan-usage.ndjson'),
    maxBytes: budget('USAGE_PUSH_MAX_BYTES', 20_000_000, 64 * 1024 * 1024),
    maxMs: budget('USAGE_PUSH_TICK_MS', 30_000, 120_000),
    host: usageHost,
  }, cursor);

  console.log(`${new Date().toISOString()} usage-push stage=collect-end bytes=${push.bytes}`);
  const roots = [
    ['claude-code', env.CLAUDE_PROJECTS_DIR ?? join(home, '.claude', 'projects')],
    ['codex', join(env.CODEX_HOME ?? join(home, '.codex'), 'sessions')],
    ...(zenSessionsDir ? [['zen', zenSessionsDir]] : []),
  ];
  for (const [runtime, path] of roots) {
    const measurement = combineMeasurements(walkFiles(path!).filter(p => p.endsWith('.jsonl')).map(p => {
      const prev = push.next.files[p];
      const st = statSync(p);
      const same = runtime === 'claude-code' ? prev?.fingerprint === fingerprintOf(p) && st.size >= prev.offset
        : prev?.size === st.size && prev.mtimeMs === st.mtimeMs;
      const measured = measureJsonl(p, same ? prev!.offset : 0, 'bytes', true);
      // Malformed complete lines are explicitly submitted as quarantine before this health line.
      return measured;
    }));
    const health: CollectionHealth = {
      v: 1, collectorInstance: cursor.instanceId!, attemptSeq: cursor.attemptSeq!, collectorVersion: 'usage-push-2',
      runtime: runtime!, path: path!, startedAt, endedAt: new Date().toISOString(), outcome: timedOut ? 'retry' : existsSync(path!) ? 'ok' : 'unsupported',
      ...measurement,
      reason: timedOut ? 'deadline' : existsSync(path!) ? null : 'unsupported', capabilities: ['heartbeat', 'backlog', 'source-time', 'quarantine'],
    };
    push.lines.push(JSON.stringify({ t: 'health', health }));
  }
  const deadline = timedOut ? 8000 : backfill ? budget('USAGE_PUSH_BACKFILL_MS', 600_000, 1_800_000) : budget('USAGE_PUSH_DEADLINE_MS', 180_000, 600_000);
  console.log(`${new Date().toISOString()} usage-push stage=upload-start deadlineMs=${deadline}`);
  const result = await runUpload('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', sshHost,
    `/usr/local/bin/secondbrain-usage-import ${usageHost} --ack-v2`], push.lines, deadline);
  if (result.ok) save(push.next);
  console.log(`${new Date().toISOString()} usage-push stage=upload-end reason=${result.reason} cursor=${result.ok ? 'saved' : 'retained'}`);
  process.exitCode = result.ok ? 0 : 1;
} catch {
  console.error(`${new Date().toISOString()} usage-push reason=collection cursor=retained`);
  process.exitCode = 1;
} finally {
  rmSync(lock, { recursive: true, force: true });
}
