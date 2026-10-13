import { describe, it, expect } from 'vitest';
import { sep } from 'node:path';
import { safeVaultPath } from '../src/paths.js';

const root = sep === '/' ? '/tmp/vault' : 'C:\\vault';

describe('safeVaultPath', () => {
  it('rejects traversal, absolute paths and null bytes', () => {
    for (const bad of [
      '../etc/passwd',
      'notes/../../etc/passwd',
      'notes/../notes/a.md',
      '/etc/passwd',
      'a\0b',
      '..',
      './../x',
      'notes/..',
    ]) {
      expect(safeVaultPath(root, bad), bad).toBeNull();
    }
  });

  it('accepts ordinary vault-relative paths', () => {
    expect(safeVaultPath(root, 'notes/alpha.md')).toBe(`${root}${sep}notes${sep}alpha.md`);
    expect(safeVaultPath(root, './notes/alpha.md')).toBe(`${root}${sep}notes${sep}alpha.md`);
    expect(safeVaultPath(root, 'a b/c (1).png')).toBe(`${root}${sep}a b${sep}c (1).png`);
  });

  it('treats the empty path as the root itself', () => {
    expect(safeVaultPath(root, '')).toBe(root);
  });

  it('does not accept a sibling directory that merely shares a prefix', () => {
    // /tmp/vault-other must not pass just because it starts with /tmp/vault.
    expect(safeVaultPath(root, `..${sep}vault-other${sep}x.md`)).toBeNull();
  });

  it('rejects a backslash-separated traversal even on posix', () => {
    expect(safeVaultPath(root, '..\\..\\etc\\passwd')).toBeNull();
  });
});
