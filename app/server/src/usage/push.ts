// Imports node builtins and pure modules only: install-usage-push-mac.sh copies this
// file's compiled output to ~/.local/share/secondbrain, where there is no node_modules.
import { existsSync, statSync, readFileSync } from 'node:fs';
import { readFrom } from './readFrom.js';
import { fingerprintOf } from '../archive/stage.js';
import { walkFiles } from './walkFiles.js';
import { splitJsonLines } from './lines.js';
import { parseStatuslineLog } from './statusline.js';
import { sha256 } from '../archive/clean.js';
import { buildRedactor } from '../archive/redact.js';
import type { WireLine } from './wire.js';

export interface PushInput { claudeProjectsDir: string; planLog: string | null; maxBytes: number; host?: string; codexSessionsDir?: string | null }
export interface PushCursor { files: Record<string, { fingerprint: string; offset: number; lines: number; processedAt?: number }> }

export function buildPush(input: PushInput, cursor: PushCursor): { lines: string[]; next: PushCursor; bytes: number } {
  const next: PushCursor = { files: { ...cursor.files } };
  const lines: string[] = [];
  let bytes = 0;
  const redact = buildRedactor({ env: process.env }); // Never open credential or env files on a collector.
  const safeText = (text: string): string => text.split('\n').map(line => {
    if (!line) return '';
    try { JSON.parse(line); return redact.jsonText(line); }
    catch { return ''; } // Keep the line position, never upload malformed secret-bearing fragments.
  }).join('\n');
  const files = walkFiles(input.claudeProjectsDir).filter((p) => p.endsWith('.jsonl')).sort();
  if (input.planLog && existsSync(input.planLog)) files.push(input.planLog);

  for (const path of files) {
    if (bytes >= input.maxBytes) break;
    const size = statSync(path).size;
    if (!size) continue;
    const fingerprint = fingerprintOf(path);
    const prev = next.files[path];
    const keep = prev && prev.fingerprint === fingerprint && size >= prev.offset ? prev : null;
    const offset = keep ? keep.offset : 0;
    const startLine = keep ? keep.lines : 0;
    if (offset >= size) continue;
    let buf = readFrom(path, offset);
    // Cap this file's slice at the remaining budget, cut at a line boundary, but always take at
    // least the first complete line so a huge file still makes progress.
    const room = Math.max(1, input.maxBytes - bytes);
    if (buf.length > room) {
      let cut = buf.lastIndexOf(10, room - 1);
      if (cut < 0) cut = buf.indexOf(10);
      if (cut >= 0) buf = buf.subarray(0, cut + 1);
    }
    const { records, consumedBytes, lines: n } = splitJsonLines(buf);
    if (!consumedBytes) continue;
    if (path === input.planLog) {
      for (const s of parseStatuslineLog(records, input.host ?? 'mac')) {
        const w: WireLine = { t: 'plan', snap: { ...s, resetsAt: s.resetsAt?.toISOString() ?? null, observedAt: s.observedAt.toISOString() } };
        lines.push(JSON.stringify(w));
      }
    } else {
      const w: WireLine = { t: 'transcript', path, startLine, text: safeText(buf.subarray(0, consumedBytes).toString('utf8')) };
      lines.push(JSON.stringify(w));
    }
    bytes += consumedBytes;
    next.files[path] = { fingerprint, offset: offset + consumedBytes, lines: startLine + n };
  }
  // Replay changed complete prefixes: identity, model and cumulative counters live earlier in the file.
  // Hash the prefix, rather than size/mtime, to detect same-size rewrites and leave torn tails pending.
  let codexSent = false;
  const nativeFiles = input.codexSessionsDir ? walkFiles(input.codexSessionsDir).filter(p => p.endsWith('.jsonl')) : [];
  nativeFiles.sort((a, b) => (cursor.files[a]?.processedAt ?? 0) - (cursor.files[b]?.processedAt ?? 0) || a.localeCompare(b));
  for (const path of nativeFiles) {
    if (bytes >= input.maxBytes && codexSent) break;
    const buf = readFileSync(path);
    const parsed = splitJsonLines(buf);
    if (!parsed.consumedBytes) continue;
    const prefix = buf.subarray(0, parsed.consumedBytes);
    const fingerprint = sha256(prefix);
    if (next.files[path]?.fingerprint === fingerprint) continue;
    // A single changed session may exceed the budget, so it cannot starve forever.
    const w: WireLine = { t: 'codex', text: safeText(prefix.toString('utf8')) };
    lines.push(JSON.stringify(w));
    bytes += prefix.length;
    codexSent = true;
    next.files[path] = { fingerprint, offset: parsed.consumedBytes, lines: parsed.lines, processedAt: Date.now() };
  }
  return { lines, next, bytes };
}
