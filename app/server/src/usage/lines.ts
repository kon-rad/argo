/**
 * Complete lines only: a file still being written usually ends in a partial line,
 * which is left for the next pass by reporting fewer consumed bytes. Lines that
 * are not JSON are counted but skipped.
 */
export function splitJsonLines(buf: Buffer): { records: unknown[]; consumedBytes: number; lines: number } {
  const lastNl = buf.lastIndexOf(0x0a);
  const consumedBytes = lastNl + 1;
  if (!consumedBytes) return { records: [], consumedBytes: 0, lines: 0 };
  const lines = buf.subarray(0, consumedBytes).toString('utf8').split('\n').slice(0, -1);
  const records: unknown[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn or non-JSON line carries no usage.
    }
  }
  return { records, consumedBytes, lines: lines.length };
}
