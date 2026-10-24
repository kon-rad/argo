import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBuildInfo } from '../src/version.js';

/** A checkout with a package version and, optionally, what a deploy wrote. */
function appDir(version: string | null, build?: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sb-version-'));
  if (version !== null) writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version }));
  if (build) {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'build-info.json'), JSON.stringify(build));
  }
  return root;
}

describe('build info', () => {
  it('reports the version from the package and the commit from the deploy', () => {
    const info = readBuildInfo(appDir('1.0.0', { version: '1.0.0', commit: 'ef02b94f2fcd14c298ff2cb4de0074869af8d05a', builtAt: '2026-10-23T17:40:00Z' }));
    expect(info).toEqual({
      version: '1.0.0',
      commit: 'ef02b94f2fcd14c298ff2cb4de0074869af8d05a',
      commitShort: 'ef02b94',
      builtAt: '2026-10-23T17:40:00Z',
    });
  });

  it('reads the version from package.json alone, with no commit, outside a git checkout', () => {
    const info = readBuildInfo(appDir('2.3.4'));
    expect(info.version).toBe('2.3.4');
    expect(info.commit).toBeNull();
    expect(info.commitShort).toBeNull();
    expect(info.builtAt).toBeNull();
  });

  it('survives a missing package.json and a broken build file', () => {
    const root = appDir(null);
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'build-info.json'), 'not json');
    const info = readBuildInfo(root);
    expect(info.version).toBe('0.0.0');
    expect(info.commit).toBeNull();
  });

  it('prefers what the deploy recorded over the package version', () => {
    const info = readBuildInfo(appDir('1.0.0', { version: '1.0.1', commit: 'abc1234def' }));
    expect(info.version).toBe('1.0.1');
    expect(info.commitShort).toBe('abc1234');
    expect(info.builtAt).toBeNull();
  });
});
