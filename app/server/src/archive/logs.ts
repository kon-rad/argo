import { clean } from './clean.js';
import type { LogLine } from './types.js';

const TS_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,6}))?/;
const LEVEL_RE = /\b(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL)\b/;

/** Complete lines only; offsets are absolute so a re-read never duplicates a line. */
export function splitLog(buf: Buffer, startOffset: number, prevTs: Date | null, assumeUtc: boolean): {
  lines: LogLine[]; consumedBytes: number; lastTs: Date | null;
} {
  const consumedBytes = buf.lastIndexOf(0x0a) + 1;
  const lines: LogLine[] = [];
  let lastTs = prevTs;
  let pos = 0;
  while (pos < consumedBytes) {
    const nl = buf.indexOf(0x0a, pos);
    const text = buf.subarray(pos, nl).toString('utf8').replace(/\r$/, '');
    const byteOffset = startOffset + pos;
    pos = nl + 1;
    if (text.trim() === '') continue;
    const m = TS_RE.exec(text);
    let level: string | null = null;
    if (m) {
      const ms = (m[3] ?? '0').padEnd(3, '0').slice(0, 3);
      const iso = `${m[1]}T${m[2]}.${ms}${assumeUtc ? 'Z' : ''}`;
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) lastTs = d;
      level = LEVEL_RE.exec(text.slice(0, 120))?.[1] ?? null;
    }
    lines.push({ byteOffset, ts: lastTs, level, message: clean(text) });
  }
  return { lines, consumedBytes, lastTs };
}
