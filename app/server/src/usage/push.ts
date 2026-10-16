// Imports node builtins and pure modules only: install-usage-push-mac.sh copies this
// file's compiled output to ~/.local/share/secondbrain, where there is no node_modules.
import { existsSync, statSync } from 'node:fs';
import { readFrom } from './readFrom.js';
import { fingerprintOf } from '../archive/stage.js';
import { walkFiles } from './walkFiles.js';
import { splitJsonLines } from './lines.js';
import { parseStatuslineLog } from './statusline.js';
import type { WireLine } from './wire.js';

export interface PushInput { claudeProjectsDir: string; planLog: string | null; maxBytes: number; host?: string }
export interface PushCursor { files: Record<string, { fingerprint: string; offset: number; lines: number }> }

export function buildPush(input: PushInput, cursor: PushCursor): { lines: string[]; next: PushCursor; bytes: number } {
  const next: PushCursor = { files: { ...cursor.files } };
  const lines: string[] = [];
  let bytes = 0;
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
      const w: WireLine = { t: 'transcript', path, startLine, text: buf.subarray(0, consumedBytes).toString('utf8') };
      lines.push(JSON.stringify(w));
    }
    bytes += consumedBytes;
    next.files[path] = { fingerprint, offset: offset + consumedBytes, lines: startLine + n };
  }
  return { lines, next, bytes };
}
