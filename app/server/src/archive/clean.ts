import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/** Postgres rejects NUL and unpaired surrogates in text and jsonb; tool output contains both. */
export function clean<T>(v: T): T {
  if (typeof v === 'string') {
    const cleaned = v.replaceAll('\u0000', '�');
    // Use typed cast for toWellFormed per R2 ruling (tsconfig lib is ES2023)
    return (cleaned as string & { toWellFormed(): string }).toWellFormed() as T;
  }
  if (Array.isArray(v)) return v.map((x) => clean(x)) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[clean(k)] = clean(x);
    return out as T;
  }
  return v;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Same input, same bytes: zlib writes no filename and a zero mtime, so rclone can skip unchanged uploads. */
export function gzipDeterministic(data: Buffer): Buffer {
  return gzipSync(data, { level: 9 });
}
