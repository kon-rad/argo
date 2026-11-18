// Imports node builtins and pure modules only: install-usage-push-mac.sh copies this
// file's compiled output to ~/.local/share/secondbrain, where there is no node_modules.
import { existsSync, statSync } from 'node:fs';
import { readFrom } from './readFrom.js';
import { fingerprintOf } from '../archive/stage.js';
import { walkFiles } from './walkFiles.js';
import { splitJsonLines } from './lines.js';
import { parseStatuslineLog } from './statusline.js';
import { sha256 } from '../archive/clean.js';
import { buildRedactor } from '../archive/redact.js';
import type { WireLine } from './wire.js';

export interface PushInput {
  claudeProjectsDir: string; planLog: string | null; maxBytes: number; maxMs?: number; host?: string; codexSessionsDir?: string | null;
  /** zen-agent traces (`.zen/sessions` in a vault, gitignored, so this is the only way a laptop's reach the server). */
  zenSessionsDir?: string | null;
}
export interface PushCursor { instanceId?: string; attemptSeq?: number; files: Record<string, { fingerprint: string; offset: number; lines: number; processedAt?: number; size?: number; mtimeMs?: number }> }

export function buildPush(input: PushInput, cursor: PushCursor): { lines: string[]; next: PushCursor; bytes: number } {
  const next: PushCursor = { ...cursor, files: { ...cursor.files } };
  const lines: string[] = [];
  let bytes = 0;
  const redact = buildRedactor({ env: process.env }); // Never open credential or env files on a collector.
  const safeText = (text: string, path: string, startLine: number): string => text.split('\n').map((line, index) => {
    if (!line) return '';
    try { JSON.parse(line); }
    catch {
      lines.push(JSON.stringify({ t: 'quarantine', reason: 'invalid-source-json', path, sourceLine: startLine + index, text: redact.text(line) }));
      return ''; // Preserve line positions; v2 import durably quarantines the redacted fragment.
    }
    return redact.jsonText(line);
  }).join('\n');
  const started = Date.now();
  const files: { path: string; type: 'transcript' | 'codex' | 'zen' | 'plan' }[] = [];
  for (const [dir, type] of [[input.claudeProjectsDir, 'transcript'], [input.codexSessionsDir, 'codex'], [input.zenSessionsDir, 'zen']] as const) {
    if (dir) for (const path of walkFiles(dir).filter(p => p.endsWith('.jsonl'))) files.push({ path, type });
  }
  if (input.planLog && existsSync(input.planLog)) files.push({ path: input.planLog, type: 'plan' });
  // One queue across runtimes. A busy Claude path cannot starve old Codex or Zen files.
  files.sort((a, b) => (cursor.files[a.path]?.processedAt ?? 0) - (cursor.files[b.path]?.processedAt ?? 0) || a.path.localeCompare(b.path));
  for (const { path, type } of files) {
    if (bytes >= input.maxBytes || Date.now() - started >= (input.maxMs ?? 30_000)) break;
    const st = statSync(path);
    if (!st.size) continue;
    const prev = cursor.files[path];
    const whole = type === 'codex' || type === 'zen';
    if (whole && prev?.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
    const fingerprint = whole ? '' : fingerprintOf(path);
    const keep = !whole && prev && prev.fingerprint === fingerprint && st.size >= prev.offset ? prev : null;
    const offset = keep?.offset ?? 0;
    if (offset >= st.size) continue;
    // Whole-prefix reconciliation and an oversized first complete record retain the
    // pre-existing protocol. maxBytes is a soft batch budget, not a source-size limit.
    let buf = readFrom(path, offset, whole ? Number.MAX_SAFE_INTEGER : Math.max(1, input.maxBytes - bytes));
    if (!whole && !buf.includes(10) && st.size - offset > buf.length) buf = readFrom(path, offset);
    let cut = buf.lastIndexOf(10);
    if (!whole && buf.length > input.maxBytes - bytes) {
      const fitting = buf.lastIndexOf(10, Math.max(0, input.maxBytes - bytes - 1));
      cut = fitting >= 0 ? fitting : buf.indexOf(10);
    }
    if (cut < 0) continue;
    buf = buf.subarray(0, cut + 1);
    const parsed = splitJsonLines(buf);
    const hash = whole ? sha256(buf) : fingerprint;
    if (whole && prev?.fingerprint === hash) {
      next.files[path] = { ...prev, size: st.size, mtimeMs: st.mtimeMs, processedAt: Date.now() };
      continue;
    }
    const text = safeText(buf.toString('utf8'), path, keep?.lines ?? 0);
    if (type === 'plan') {
      for (const snap of parseStatuslineLog(parsed.records, input.host ?? 'mac')) lines.push(JSON.stringify({ t: 'plan', snap: {
        ...snap, resetsAt: snap.resetsAt?.toISOString() ?? null, observedAt: snap.observedAt.toISOString(),
      } } satisfies WireLine));
    } else if (type === 'transcript') lines.push(JSON.stringify({ t: type, path, startLine: keep?.lines ?? 0, text } satisfies WireLine));
    else if (type === 'codex') lines.push(JSON.stringify({ t: type, path, text } satisfies WireLine));
    else lines.push(JSON.stringify({ t: type, path, mtimeMs: st.mtimeMs, text } satisfies WireLine));
    bytes += buf.length;
    next.files[path] = { fingerprint: hash, offset: offset + buf.length, lines: (keep?.lines ?? 0) + parsed.lines,
      processedAt: Date.now(), size: st.size, mtimeMs: st.mtimeMs };
  }
  return { lines, next, bytes };
}
