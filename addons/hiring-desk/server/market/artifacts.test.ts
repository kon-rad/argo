import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TrustedMp4Artifacts } from './artifacts.js';
const roots: string[] = [];
const mp4 = Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0]);
async function setup() { const root = await mkdtemp(join(tmpdir(), 'cyba-artifact-')); roots.push(root); const stage = join(root, 'stage'); await mkdir(stage); return { root, stage, reader: new TrustedMp4Artifacts(stage, 128) }; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe('private reviewed artifacts', () => {
  it('reads bounded MP4 bytes and rejects changes after review', async () => {
    const s = await setup(); await writeFile(join(s.stage,'video.mp4'),mp4);
    const read = await s.reader.read('video.mp4'); expect(read.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await s.reader.readBound(read.path, read.sha256)).toEqual(new Uint8Array(mp4));
    await writeFile(read.path,Buffer.concat([mp4,Buffer.from('changed')]));
    await expect(s.reader.readBound(read.path,read.sha256)).rejects.toThrow('changed');
  });
  it('denies traversal, symlinks, invalid media, directories and excessive bytes', async () => {
    const s = await setup(); await writeFile(join(s.root,'outside.mp4'),mp4);
    await expect(s.reader.read('../outside.mp4')).rejects.toThrow('inside');
    await symlink(join(s.root,'outside.mp4'),join(s.stage,'link.mp4'));
    await expect(s.reader.read('link.mp4')).rejects.toThrow();
    await writeFile(join(s.stage,'bad.mp4'),Buffer.alloc(16)); await expect(s.reader.read('bad.mp4')).rejects.toThrow('header');
    await writeFile(join(s.stage,'big.mp4'),Buffer.alloc(129)); await expect(s.reader.read('big.mp4')).rejects.toThrow('bounded');
    await mkdir(join(s.stage,'directory')); await expect(s.reader.read('directory')).rejects.toThrow('bounded');
  });
});
