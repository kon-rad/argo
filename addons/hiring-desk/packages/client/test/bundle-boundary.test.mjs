import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

test('public browser output has no private server and credential references', async () => {
  const dir = resolve(import.meta.dirname, '../../public/dist/assets');
  const files = await readdir(dir).catch(() => []);
  assert.ok(files.length, 'build desk-public before running the bundle boundary check');
  for (const file of files) {
    const content = await readFile(resolve(dir, file), 'utf8');
    assert.doesNotMatch(content, /server\/src|operator\/approve|DATABASE_URL|SECRET_ACCESS_KEY|vault_files/);
    assert.doesNotMatch(content, /\.innerHTML|dangerouslySetInnerHTML/);
  }
});
