import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packageDigest } from '../src/skillpkg.js';

for (const filename of ['auth.json', '.credentials.json', 'credentials.json', '.pypirc']) {
  test(`managed packages refuse ${filename}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'zen-package-safety-'));
    try {
      writeFileSync(join(root, 'SKILL.md'), '# Synthetic fixture');
      writeFileSync(join(root, filename), '{"fixture":"not a real credential"}');
      assert.equal(packageDigest(root).ok, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('managed packages refuse aliases into ignored credential directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'zen-package-safety-'));
  try {
    writeFileSync(join(root, 'SKILL.md'), '# Synthetic fixture');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'credentials.json'), 'synthetic-only');
    symlinkSync('node_modules/credentials.json', join(root, 'notes.txt'));
    assert.equal(packageDigest(root).ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('managed packages accept normal in-package links and environment templates', () => {
  const root = mkdtempSync(join(tmpdir(), 'zen-package-safety-'));
  try {
    writeFileSync(join(root, 'SKILL.md'), '# Synthetic fixture');
    writeFileSync(join(root, '.env.sample'), 'EXAMPLE_NAME=\n');
    writeFileSync(join(root, 'guide.md'), '# Guide');
    symlinkSync('guide.md', join(root, 'alias.md'));
    assert.equal(packageDigest(root).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
