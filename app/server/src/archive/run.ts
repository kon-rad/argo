import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve as resolvePath } from 'node:path';
import { redactExisting } from './backfill.js';
import { ingest, type Counts, type Item } from './ingest.js';
import { walkFiles as walk } from '../usage/walkFiles.js';
import * as stage from './stage.js';
import * as store from './store.js';
import type { Host } from './types.js';

export interface ArchivePaths {
  claudeProjectsDir: string; claudePrefix: string; hermesHome: string; stateDir: string;
  /** A second Hermes home on this machine (the user's default ~/.hermes when the vault runs its own); archived as 'hermes:user'. */
  hermesUserHome?: string | null;
}
export interface RunDeps {
  paths: ArchivePaths; now: () => Date; log: (msg: string) => void;
  snapshotSqlite: (src: string, dest: string) => Promise<void>;
  pullDroplet: (destDir: string) => Promise<void>;
  upload: (outboxRoot: string) => Promise<void>;
}
export interface RunOptions {
  dryRun?: boolean; upload?: boolean; droplet?: boolean;
  /** Redact rows added since the last run with this machine's env values (default on). */
  redactNew?: boolean;
}
export interface RunSummary {
  startedAt: string; durationMs: number; droplet: 'ok' | 'skipped' | 'disabled';
  staged: number; uploaded: number; uploadError: string | null;
  ingested: Record<string, Counts>; errors: string[];
  redacted?: { messages: number; sessions: number };
}

export function defaultPaths(vaultRoot: string, home: string): ArchivePaths {
  return {
    claudeProjectsDir: join(home, '.claude', 'projects'),
    // Claude Code names a project dir by replacing every non-alphanumeric char of the cwd with '-'.
    claudePrefix: vaultRoot.replace(/[^A-Za-z0-9]/g, '-'),
    hermesHome: join(vaultRoot, '.hermes'),
    hermesUserHome: join(home, '.hermes'),
    stateDir: join(home, 'Library', 'Application Support', 'secondbrain-archive'),
  };
}

// The server's Hermes home as recorded in archive rows; keep it stable, it is part of each row's identity.
const DROPLET_HOME = `droplet:${process.env.REMOTE_HERMES_HOME ?? '~/.hermes'}`;


function listFiles(dir: string, filter: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && filter(e.name)).map((e) => join(dir, e.name));
}

export { walkFiles as walk } from '../usage/walkFiles.js';


function acquireLock(dir: string): boolean {
  try { mkdirSync(dir); } catch {
    const pid = Number(existsSync(join(dir, 'pid')) ? readFileSync(join(dir, 'pid'), 'utf8') : NaN);
    let alive = false;
    if (pid) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
    if (alive) return false;
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir);
  }
  writeFileSync(join(dir, 'pid'), String(process.pid));
  return true;
}

export async function runArchive(deps: RunDeps, opts: RunOptions = {}): Promise<RunSummary | null> {
  const { paths } = deps;
  mkdirSync(paths.stateDir, { recursive: true });
  const lockDir = join(paths.stateDir, 'lock');
  if (!acquireLock(lockDir)) { deps.log('another archive run is active; exiting'); return null; }
  const t0 = Date.now();
  const now = deps.now();
  const stamp = stage.utcStamp(now); const today = stage.utcDate(now);
  const work = join(paths.stateDir, 'work'); const outbox = join(paths.stateDir, 'outbox');
  const summary: RunSummary = { startedAt: now.toISOString(), durationMs: 0, droplet: 'disabled', staged: 0, uploaded: 0,
    uploadError: null, ingested: {}, errors: [] };
  const bump = (src: string, k: keyof Counts, n = 1) => {
    summary.ingested[src] ??= { files: 0, sessions: 0, messages: 0, logLines: 0, memoryVersions: 0 };
    summary.ingested[src]![k] += n;
  };

  try {
    if (!opts.dryRun) { rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true }); }
    // First run with redaction: start at the rows that exist now (older ones: `secondbrain archive-steps --redact`).
    const redactStart = opts.redactNew !== false && !existsSync(join(paths.stateDir, 'redact-cursor.json')) ? await store.maxMessageId() : null;
    const items: Item[] = [];

    // --- Claude Code (vault projects only) ---
    const projects = existsSync(paths.claudeProjectsDir)
      ? readdirSync(paths.claudeProjectsDir).filter((n) => n === paths.claudePrefix || n.startsWith(paths.claudePrefix + '-')) : [];
    for (const project of projects) {
      const pdir = join(paths.claudeProjectsDir, project);
      for (const f of walk(pdir)) {
        const rel = relative(pdir, f);
        if (rel.startsWith('memory/')) continue;
        if (!/\.(jsonl|json)$/.test(rel)) continue;
        const sid = rel.split('/')[0]!.replace(/\.jsonl$/, '');
        try {
          items.push({ source: 'claude-code', host: 'mac', localPath: f, logical: f, project,
            b2Desired: stage.claudeB2Path(project, rel, stage.firstTimestamp(f), now),
            kind: rel.endsWith('.jsonl') ? 'claude' : 'blob', parentSid: rel.includes('/') ? sid : undefined });
        } catch (err) { summary.errors.push(`claude-code ${f}: ${(err as Error).message}`); }
      }
    }
    for (const f of listFiles(join(paths.claudeProjectsDir, paths.claudePrefix, 'memory'), (n) => n.endsWith('.md')))
      items.push({ source: 'claude-memory', host: 'mac', localPath: f, logical: f, kind: 'memory',
        b2Desired: `archives/claude-memory/${stamp}/${basename(f)}.gz` });

    // --- Hermes (mac, then droplet) ---
    const hermesSets: Array<{ host: Host; home: string; logicalHome: string }> = [];
    // The mac set is always scanned; only the state.db item depends on the snapshot (existsSync gates it).
    hermesSets.push({ host: 'mac', home: paths.hermesHome, logicalHome: paths.hermesHome });
    if (!opts.dryRun) {
      try { await deps.snapshotSqlite(join(paths.hermesHome, 'state.db'), join(work, 'mac', 'state.db')); }
      catch (err) { summary.errors.push(`mac hermes snapshot: ${(err as Error).message}`); }
    }
    // The user's own ~/.hermes, when it is a different home from the vault's: its state.db only.
    const userHome = paths.hermesUserHome && resolvePath(paths.hermesUserHome) !== resolvePath(paths.hermesHome)
      && existsSync(join(paths.hermesUserHome, 'state.db')) ? paths.hermesUserHome : null;
    if (userHome) {
      const snap = join(work, 'mac-user', 'state.db');
      if (!opts.dryRun) {
        try { await deps.snapshotSqlite(join(userHome, 'state.db'), snap); }
        catch (err) { summary.errors.push(`mac user hermes snapshot: ${(err as Error).message}`); }
      }
    }
    if (opts.droplet !== false && opts.dryRun) summary.droplet = 'skipped'; // dry run: no SSH
    else if (opts.droplet !== false) {
      try {
        await deps.pullDroplet(join(work, 'droplet'));
        summary.droplet = 'ok';
        hermesSets.push({ host: 'droplet', home: join(work, 'droplet'), logicalHome: DROPLET_HOME });
      } catch (err) { summary.droplet = 'skipped'; deps.log(`droplet skipped: ${(err as Error).message}`); }
    }
    for (const { host, home, logicalHome } of hermesSets) {
      const snap = host === 'mac' ? join(work, 'mac', 'state.db') : join(home, 'state.db');
      if (existsSync(snap)) items.push({ source: 'hermes', host, localPath: snap, logical: `${logicalHome}/state.db`,
        kind: 'hermes-db', daily: true, b2Desired: `archives/hermes/${host}/state/${today}.sqlite.gz` });
      for (const f of listFiles(join(home, 'logs'), (n) => n.endsWith('.log')))
        items.push({ source: 'hermes-logs', host, localPath: f, logical: `${logicalHome}/logs/${basename(f)}`, kind: 'log',
          b2Desired: `archives/hermes/${host}/logs/${today}/${basename(f)}.gz` });
      for (const f of listFiles(join(home, 'memories'), (n) => n.endsWith('.md')))
        items.push({ source: 'hermes-memory', host, localPath: f, logical: `${logicalHome}/memories/${basename(f)}`, kind: 'memory',
          b2Desired: `archives/hermes/${host}/memories/${stamp}/${basename(f)}.gz` });
      for (const f of listFiles(join(home, 'sessions'), (n) => n.endsWith('.json')))
        items.push({ source: 'hermes-dumps', host, localPath: f, logical: `${logicalHome}/sessions/${basename(f)}`, kind: 'blob',
          b2Desired: `archives/hermes/${host}/request-dumps/${basename(f)}.gz` });
      if (host === 'mac') for (const f of listFiles(join(home, 'pastes'), (n) => !n.startsWith('.')))
        items.push({ source: 'hermes-pastes', host, localPath: f, logical: `${logicalHome}/pastes/${basename(f)}`, kind: 'blob',
          b2Desired: `archives/hermes/${host}/pastes/${basename(f)}.gz` });
    }
    // After the main home, so its sessions are in before the user home is checked against them.
    if (userHome && existsSync(join(work, 'mac-user', 'state.db'))) items.push({ source: 'hermes:user', host: 'mac',
      localPath: join(work, 'mac-user', 'state.db'), logical: `${userHome}/state.db`, kind: 'hermes-db', daily: true,
      b2Desired: `archives/hermes/mac-user/state/${today}.sqlite.gz`, dedupeDb: join(work, 'mac', 'state.db') });

    // --- Stage ---
    const changedItems: Array<{ item: Item; prev: store.FileRow | null; st: stage.FileState }> = [];
    for (const item of items) {
      try {
        const prev = await store.getFile(item.source, item.host, item.logical);
        const st = stage.fileState(item.localPath, prev);
        let stageKey: string; // where this upload goes
        let b2Path: string;   // the canonical key persisted on the row
        let upload: boolean;
        if (item.daily) {
          // One snapshot per UTC day; later runs that day only re-ingest.
          b2Path = stageKey = item.b2Desired;
          upload = !prev || prev.b2Path !== b2Path || prev.uploadedAt === null;
        } else if (item.kind === 'memory' || item.kind === 'log') {
          // Stamped/dated paths: a new key whenever content changes.
          upload = stage.needsUpload(prev, st);
          b2Path = stageKey = upload && prev?.sha256 !== st.sha256 ? item.b2Desired : (prev?.b2Path ?? item.b2Desired);
        } else {
          upload = stage.needsUpload(prev, st);
          // The canonical key never moves; a shrunken file is staged under a .truncated key for one upload only.
          b2Path = prev?.b2Path ?? item.b2Desired;
          stageKey = stage.resolveB2Path(prev, st, item.b2Desired, stamp);
        }
        if (upload && !opts.dryRun) {
          stage.stageToOutbox(outbox, item.localPath, stageKey);
          summary.staged++;
        }
        if (item.kind === 'log' && prev?.fingerprint && prev.fingerprint !== st.fingerprint) {
          // Hermes rotated this log: the old file's unseen tail lives in `<name>.1`.
          const rotated = `${item.localPath}.1`;
          if (existsSync(rotated) && stage.fingerprintOf(rotated) === prev.fingerprint) {
            item.rotatedPath = rotated;
            if (!opts.dryRun) {
              stage.stageToOutbox(outbox, rotated, item.b2Desired.replace(/\.gz$/, '.1.gz'));
              summary.staged++;
            }
          }
        }
        const unchanged = !!prev && prev.sizeBytes === st.sizeBytes
          // mtime alone is not worth a row (fresh snapshots always have a new one); the next scan just re-hashes.
          && prev.sha256 === st.sha256 && prev.b2Path === b2Path && !upload;
        if (!opts.dryRun && !unchanged) await store.saveFileState(null, { source: item.source, host: item.host, localPath: item.logical,
          sizeBytes: st.sizeBytes, mtimeMs: st.mtimeMs, sha256: st.sha256, fingerprint: prev?.fingerprint ?? null,
          b2Path, staged: upload });
        // Ingest whenever the source is not fully ingested yet, so a failed ingest retries next run.
        const pendingIngest = item.kind !== 'blob' && (!prev || prev.sha256 !== st.sha256 || prev.ingestedBytes !== st.sizeBytes);
        if (pendingIngest) changedItems.push({ item, prev, st });
      } catch (err) { summary.errors.push(`${item.source} ${item.logical}: ${(err as Error).message}`); }
    }
    if (opts.dryRun) { deps.log(`dry run: ${changedItems.length} to ingest of ${items.length} files`); return summary; }

    // --- Upload (one call; failure leaves rows pending for the next run) ---
    const pending = await store.pendingUploads();
    if (opts.upload !== false && pending.length && existsSync(join(outbox, 'archives'))) {
      try {
        await deps.upload(outbox);
        await store.markUploaded(pending.map((p) => p.id));
        summary.uploaded = pending.length;
        rmSync(outbox, { recursive: true, force: true });
      } catch (err) { summary.uploadError = (err as Error).message; }
    }
    // A pending row is re-staged on the next run anyway: needsUpload() is true while uploaded_at is null.

    // --- Ingest ---
    for (const { item } of changedItems) {
      try {
        await ingest(item, summary.errors, bump);
      } catch (err) { summary.errors.push(`${item.source} ${item.logical}: ${(err as Error).message}`); }
    }

    // --- Redact new rows with this machine's env values ---
    // Other machines push transcripts that the server redacts with the server's env only; this
    // machine's own secrets (the vault .env) are caught here, within one run of arriving.
    if (opts.redactNew !== false) {
      try {
        const cursorFile = join(paths.stateDir, 'redact-cursor.json');
        let sinceId: number;
        if (existsSync(cursorFile)) sinceId = Number(JSON.parse(readFileSync(cursorFile, 'utf8')).lastId) || 0;
        else sinceId = redactStart ?? 0;
        const r = await redactExisting({ batch: 2000, dryRun: false, log: () => {}, sinceId });
        writeFileSync(cursorFile, JSON.stringify({ lastId: r.lastId, at: deps.now().toISOString() }));
        summary.redacted = { messages: r.changed, sessions: r.sessions };
      } catch (err) { summary.errors.push(`redact: ${(err as Error).message}`); }
    }
    return summary;
  } finally {
    summary.durationMs = Date.now() - t0;
    rmSync(lockDir, { recursive: true, force: true });
  }
}
