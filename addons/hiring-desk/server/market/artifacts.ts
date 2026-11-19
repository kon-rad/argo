import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { CybaError } from './types.js';

/** Only a configured private staging root can supply a reviewed delivery. */
export class TrustedMp4Artifacts {
  constructor(private readonly root: string, private readonly maxBytes = 10_000_000) {
    if (!isAbsolute(root) || !Number.isSafeInteger(maxBytes) || maxBytes < 12 || maxBytes > 100_000_000) throw new Error('Invalid private artifact configuration');
  }
  async read(reference: string): Promise<{ path: string; sha256: string; bytes: Uint8Array }> {
    if (!reference || reference.includes('\0')) throw new CybaError(400, 'Invalid private artifact reference.');
    const root = await realpath(this.root);
    const candidate = resolve(root, reference);
    const inside = (path: string) => { const rel = relative(root, path); return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
    if (!inside(candidate) || dirname(candidate) !== root) throw new CybaError(400, 'Artifact must be a direct file inside the trusted delivery staging root.');
    const canonical = await realpath(candidate);
    if (!inside(canonical) || canonical !== candidate) throw new CybaError(400, 'Artifact symlinks are not accepted.');
    const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size < 12 || before.size > this.maxBytes) throw new CybaError(400, 'Artifact is not a bounded MP4 file.');
      const bytes = new Uint8Array(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (chunk.bytesRead === 0) throw new CybaError(409, 'Artifact changed while reading.');
        offset += chunk.bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new CybaError(409, 'Artifact changed while reading.');
      if (Buffer.from(bytes.subarray(4, 8)).toString('ascii') !== 'ftyp') throw new CybaError(400, 'Artifact does not contain an MP4 file header.');
      return { path: canonical, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
    } finally { await handle.close(); }
  }
  async readBound(path: string, sha256: string): Promise<Uint8Array> {
    const artifact = await this.read(path);
    if (artifact.sha256 !== sha256) throw new CybaError(409, 'Artifact bytes changed after review.');
    return artifact.bytes;
  }
}
