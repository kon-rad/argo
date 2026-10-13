import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gzipDeterministic, sha256 } from './clean.js';
import type { FileRow } from './store.js';

export interface FileState { sizeBytes: number; mtimeMs: number; sha256: string; fingerprint: string }

function head(path: string, bytes: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
}

/** sha256 of the file's first line (or first 4 KiB): identifies a log across appends, changes on rotation. */
export function fingerprintOf(path: string): string {
  const h = head(path, 4096);
  const nl = h.indexOf(0x0a);
  return sha256(nl >= 0 ? h.subarray(0, nl + 1) : h);
}

export function fileState(path: string, prev: FileRow | null): FileState {
  const st = statSync(path);
  const mtimeMs = Math.floor(st.mtimeMs);
  const fingerprint = fingerprintOf(path);
  const same = prev && prev.sizeBytes === st.size && prev.mtimeMs === mtimeMs;
  return { sizeBytes: st.size, mtimeMs, fingerprint, sha256: same ? prev.sha256 : sha256(readFileSync(path)) };
}

export function needsUpload(prev: FileRow | null, st: FileState): boolean {
  return !prev || prev.sha256 !== st.sha256 || prev.uploadedAt === null;
}

export function utcStamp(d: Date): string { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
export function utcDate(d: Date): string { return d.toISOString().slice(0, 10); }

export function resolveB2Path(prev: FileRow | null, st: FileState, desired: string, stamp: string): string {
  const current = prev?.b2Path ?? desired;
  if (prev?.uploadedSize != null && st.sizeBytes < prev.uploadedSize) {
    const dir = dirname(current); const base = basename(current);
    const dot = base.indexOf('.');
    const named = dot < 0 ? `${base}.truncated-${stamp}` : `${base.slice(0, dot)}.truncated-${stamp}${base.slice(dot)}`;
    return `${dir}/${named}`;
  }
  return current;
}

/** relPath is relative to the project dir: `<sid>.jsonl` or `<sid>/subagents/<file>`. */
export function claudeB2Path(projectDir: string, relPath: string, firstTs: Date | null, fallback: Date): string {
  const date = utcDate(firstTs ?? fallback);
  const [first, ...rest] = relPath.split('/');
  const named = rest.length ? [`${date}_${first}`, ...rest].join('/') : `${date}_${first}`;
  return `archives/claude-code/${projectDir}/${named}.gz`;
}

const TS_RE = /"timestamp":"(\d{4}-\d{2}-\d{2}T[^"]+)"/;
export function firstTimestamp(path: string): Date | null {
  const m = TS_RE.exec(head(path, 256 * 1024).toString('utf8'));
  if (!m) return null;
  const d = new Date(m[1]!);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function stageToOutbox(outboxRoot: string, localPath: string, b2Path: string): void {
  const dest = join(outboxRoot, b2Path);
  const src = statSync(localPath);
  // Identical content keeps an identical mtime, so rclone (no hash on the crypt remote) does not re-transfer it.
  if (existsSync(dest) && Math.floor(statSync(dest).mtimeMs) === Math.floor(src.mtimeMs)) return;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, gzipDeterministic(readFileSync(localPath)));
  utimesSync(dest, src.atime, src.mtime);
}
