import { describe, expect, it } from 'vitest';
import {
  cleanDestDir,
  cleanFilename,
  partCountFor,
  partSizeFor,
  stubMarkdown,
  suggestDestination,
  uniqueName,
  UploadInputError,
} from '../src/uploads/paths.js';

describe('upload paths', () => {
  it('keeps only the leaf of a file name and strips path-breaking characters', () => {
    expect(cleanFilename('C:\\Users\\me\\My Vlog: day 1?.mp4')).toBe('My Vlog- day 1-.mp4');
    expect(cleanFilename('../../etc/passwd')).toBe('passwd');
    expect(cleanFilename('  ..hidden.mov ')).toBe('hidden.mov');
    expect(() => cleanFilename('')).toThrow(UploadInputError);
    expect(() => cleanFilename('x.B2.md')).toThrow(UploadInputError);
    expect(() => cleanFilename('a'.repeat(201))).toThrow(UploadInputError);
  });

  it('accepts a folder under a PARA bucket and refuses anything else', () => {
    expect(cleanDestDir('Areas/alex/vlogs/')).toBe('Areas/alex/vlogs');
    expect(cleanDestDir('/Projects//x/raw')).toBe('Projects/x/raw');
    for (const bad of ['', 'Areas/../.hermes', '.hermes/x', 'Inbox/x', 'CURRENT', 'Areas/a:b', '../Areas/x']) {
      expect(() => cleanDestDir(bad), bad).toThrow(UploadInputError);
    }
  });

  it('sizes parts: 64 MiB minimum, never more than 9000 parts', () => {
    const GiB = 1024 ** 3;
    expect(partSizeFor(1 * GiB)).toBe(64 * 1024 ** 2);
    expect(partCountFor(5 * GiB, partSizeFor(5 * GiB))).toBe(80);
    const huge = 2000 * GiB;
    expect(partCountFor(huge, partSizeFor(huge))).toBeLessThanOrEqual(9000);
  });

  it('numbers a name that is taken', () => {
    expect(uniqueName('a.mp4', new Set())).toBe('a.mp4');
    expect(uniqueName('a.mp4', new Set(['a.mp4', 'a-2.mp4']))).toBe('a-3.mp4');
    expect(uniqueName('noext', new Set(['noext']))).toBe('noext-2');
  });

  it('suggests a preset folder from the file name and description', () => {
    const presets = [
      { label: 'Vlogs', path: 'Areas/x/vlogs', keywords: ['vlog', 'daily'] },
      { label: 'Drone', path: 'Areas/x/drone', keywords: ['dji', 'flight'] },
    ];
    expect(suggestDestination(presets, 'my VLOG from Tokyo')?.path).toBe('Areas/x/vlogs');
    expect(suggestDestination(presets, 'DJI_0042.MP4')?.path).toBe('Areas/x/drone');
    expect(suggestDestination(presets, 'budget.xlsx')).toBeNull();
  });

  it('writes a stub the scanner reads back as a b2-media note', () => {
    const md = stubMarkdown({
      name: 'day 1.mp4',
      b2Path: 'vault/Areas/x/vlogs/day 1.mp4',
      bytes: 3 * 1024 ** 3,
      uploadedAt: new Date('2026-10-28T10:00:00Z'),
      description: 'Day "one" in Tokyo',
      tags: ['vlog'],
      uploadId: 'u1',
    });
    expect(md).toContain('type: b2-media\nb2_path: vault/Areas/x/vlogs/day 1.mp4\nbytes: 3221225472');
    expect(md).toContain('description: "Day \\"one\\" in Tokyo"');
    expect(md).toContain('tags:\n  - "vlog"');
    expect(md).toContain('b2store fetch "vault/Areas/x/vlogs/day 1.mp4"');
  });
});
