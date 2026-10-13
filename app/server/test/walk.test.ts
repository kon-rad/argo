import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkVault } from '../src/connectors/vault/walk.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vaultwalk-'));
  await mkdir(join(root, 'notes/deep'), { recursive: true });
  await mkdir(join(root, 'notes/repo/node_modules/pkg'), { recursive: true });
  await mkdir(join(root, 'notes/repo/.git'), { recursive: true });
  await mkdir(join(root, '.obsidian'), { recursive: true });
  await mkdir(join(root, 'app'), { recursive: true });
  await mkdir(join(root, 'Areas/video-editor/app'), { recursive: true });
  await writeFile(join(root, 'top.md'), '# top');
  await writeFile(join(root, 'notes/deep/nested.md'), '# nested');
  await writeFile(join(root, 'notes/repo/src.ts'), 'export {}');
  await writeFile(join(root, 'notes/repo/node_modules/pkg/README.md'), 'junk');
  await writeFile(join(root, 'notes/repo/.git/config'), '[core]');
  await writeFile(join(root, '.obsidian/app.json'), '{}');
  await writeFile(join(root, 'app/package.json'), '{}');
  await writeFile(join(root, 'Areas/video-editor/app/notes.md'), '# a real note in a folder called app');
  await writeFile(join(root, '.env'), 'ANTHROPIC_API_KEY=sk-live-do-not-index');
  await writeFile(join(root, '.env.example'), 'ANTHROPIC_API_KEY=');
  await writeFile(join(root, 'Areas/.env.bak-1786190702'), 'GEMINI_API_KEY=real');
  await writeFile(join(root, 'Areas/deploy.pem'), '-----BEGIN PRIVATE KEY-----');
  await writeFile(join(root, 'image.png'), Buffer.from([0x89, 0x50]));
  await symlink(join(root, 'notes'), join(root, 'link-to-notes')).catch(() => {});
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe('walkVault', () => {
  it('prunes excluded directories at any depth', async () => {
    const { files } = await walkVault(root);
    expect(files.map((f) => f.path).sort()).toEqual([
      'Areas/video-editor/app/notes.md',
      'image.png', 'notes/deep/nested.md', 'notes/repo/src.ts', 'top.md',
    ]);
  });

  it('reports what it pruned, without counting inside it', async () => {
    const { skippedDirs } = await walkVault(root);
    expect(skippedDirs.map((d) => d.path).sort()).toEqual([
      '.obsidian', 'app', 'notes/repo/.git', 'notes/repo/node_modules',
    ]);
    for (const d of skippedDirs) {
      expect(d).toHaveProperty('rule');
      expect(d).not.toHaveProperty('files');
    }
  });

  it('does not follow symlinks', async () => {
    const { files } = await walkVault(root);
    expect(files.some((f) => f.path.startsWith('link-to-notes'))).toBe(false);
  });

  it('records parentPath, name and ext for the tree', async () => {
    const { files } = await walkVault(root);
    const nested = files.find((f) => f.path === 'notes/deep/nested.md')!;
    expect(nested.parentPath).toBe('notes/deep');
    expect(nested.name).toBe('nested.md');
    expect(nested.ext).toBe('.md');
    expect(nested.sizeBytes).toBeGreaterThan(0);

    const top = files.find((f) => f.path === 'top.md')!;
    expect(top.parentPath).toBe('');
  });

  it('honours a caller-supplied skip list, REPLACING the defaults', async () => {
    // Replacement, not union: sources.config.skip_dirs is the whole list.
    const { files } = await walkVault(root, { skipDirs: ['notes', '.obsidian', 'app'] });
    expect(files.map((f) => f.path).sort()).toEqual(['image.png', 'top.md']);
  });
});

describe('the app rule is anchored to the vault root', () => {
  it('prunes the vault\'s own app/ but not a project folder called app', async () => {
    const { files, skippedDirs } = await walkVault(root);
    expect(files.some((f) => f.path.startsWith('app/'))).toBe(false);
    expect(files.map((f) => f.path)).toContain('Areas/video-editor/app/notes.md');
    expect(skippedDirs.map((d) => d.path)).toContain('app');
    expect(skippedDirs.map((d) => d.path)).not.toContain('Areas/video-editor/app');
  });

  it('still prunes a name rule at any depth', async () => {
    const { skippedDirs } = await walkVault(root);
    expect(skippedDirs.map((d) => d.path)).toContain('notes/repo/node_modules');
  });
});

describe('secret files', () => {
  it('never walks a .env, a backup of one, or a private key', async () => {
    const { files } = await walkVault(root);
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('.env.example');
    expect(paths).not.toContain('Areas/.env.bak-1786190702');
    expect(paths).not.toContain('Areas/deploy.pem');
  });

  it('cannot be switched off by a caller-supplied skip list', async () => {
    // The secret filter is not part of skipDirs on purpose: a filter someone
    // can configure away is a filter that will one day be configured away.
    const { files } = await walkVault(root, { skipDirs: [] });
    expect(files.map((f) => f.path)).not.toContain('.env');
  });
});
