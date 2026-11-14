import { inflateRawSync } from 'node:zlib';

/**
 * Untrusted artifact archives are read in memory and never extracted to disk. Every member is checked
 * against the central directory before any data is inflated: count, name, file type, declared sizes and
 * the running expanded total. Inflation is capped at the declared size and the CRC must match.
 */
export type ZipLimits = { maxEntries: number; maxTotalBytes: number; maxEntryBytes(name: string): number; allowed(name: string): boolean };

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
export function crc32(data: Buffer): number {
  let c = -1;
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function readZip(zip: Buffer, limits: ZipLimits): Map<string, Buffer> {
  const fail = (why: string): never => { throw new Error(`artifact archive refused: ${why}`); };
  // End of central directory: fixed 22 bytes plus a comment of at most 65535.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) fail('no end of central directory');
  const entries = zip.readUInt16LE(eocd + 10), size = zip.readUInt32LE(eocd + 12), offset = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt16LE(eocd + 4) !== 0 || zip.readUInt16LE(eocd + 6) !== 0 || zip.readUInt16LE(eocd + 8) !== entries) fail('multi-disk archive');
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) fail('zip64 archive');
  if (entries > limits.maxEntries) fail(`${entries} members, limit ${limits.maxEntries}`);
  if (offset + size > eocd) fail('central directory out of range');
  const out = new Map<string, Buffer>();
  let p = offset, total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > eocd || zip.readUInt32LE(p) !== 0x02014b50) fail('bad central directory entry');
    const flags = zip.readUInt16LE(p + 8), method = zip.readUInt16LE(p + 10), crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20), usize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28), extraLen = zip.readUInt16LE(p + 30), commentLen = zip.readUInt16LE(p + 32);
    const madeBy = zip.readUInt16LE(p + 4) >> 8, external = zip.readUInt32LE(p + 38), local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) fail(`${name}: encrypted`);
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) fail(`${name}: zip64 member`);
    // Unix file type from the high bits of the external attributes (made-by 3 = Unix). Only plain files.
    const type = (external >>> 16) & 0o170000;
    if (name.endsWith('/')) { if (usize !== 0) fail(`${name}: directory with data`); continue; }
    if (madeBy === 3 && type !== 0 && type !== 0o100000) fail(`${name}: not a regular file`);
    if (madeBy !== 3 && madeBy !== 0 && madeBy !== 10 && madeBy !== 19 && madeBy !== 20) fail(`${name}: unknown host system`);
    if (!limits.allowed(name)) fail(`${name}: unexpected member name`);
    if (out.has(name)) fail(`${name}: duplicate member`);
    if (usize > limits.maxEntryBytes(name)) fail(`${name}: ${usize} bytes, limit ${limits.maxEntryBytes(name)}`);
    total += usize;
    if (total > limits.maxTotalBytes) fail(`expanded size above ${limits.maxTotalBytes} bytes`);
    if (method !== 0 && method !== 8) fail(`${name}: compression method ${method}`);
    if (local + 30 > eocd || zip.readUInt32LE(local) !== 0x04034b50) fail(`${name}: bad local header`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + csize > offset) fail(`${name}: data out of range`);
    const raw = zip.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = raw;
    else { try { data = inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) }); } catch { return fail(`${name}: expands beyond its declared size or is corrupt`); } }
    if (data.length !== usize || crc32(data) !== crc) fail(`${name}: size or CRC mismatch`);
    out.set(name, Buffer.from(data));
  }
  return out;
}
