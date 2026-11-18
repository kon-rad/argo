import { closeSync, openSync, readSync, statSync } from 'node:fs';

export function readFrom(path: string, offset: number, maxBytes = Number.MAX_SAFE_INTEGER): Buffer {
  const size = statSync(path).size;
  if (offset >= size) return Buffer.alloc(0);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size - offset, maxBytes));
    readSync(fd, buf, 0, buf.length, offset);
    return buf;
  } finally {
    closeSync(fd);
  }
}
