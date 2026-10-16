import { closeSync, openSync, readSync, statSync } from 'node:fs';

export function readFrom(path: string, offset: number): Buffer {
  const size = statSync(path).size;
  if (offset >= size) return Buffer.alloc(0);
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return buf;
  } finally {
    closeSync(fd);
  }
}
