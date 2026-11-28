import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readHostRegistry } from '../src/hosts/config.js';
import { scaffoldHostDefinition } from '../src/hosts/scaffold.js';

let vault: string;
beforeEach(() => { vault = mkdtempSync(join(tmpdir(), 'host-scaffold-')); });
afterEach(() => rmSync(vault, { recursive: true, force: true }));

it('generates definitions that the registry can preview independently', () => {
  const path = scaffoldHostDefinition(vault, ['machine', 'worker-1']);
  expect(path).toBe(join(vault, '.agents/org/config/machines/worker-1.yaml'));
  expect(readHostRegistry(vault)).toEqual({ machines: [{ id: 'worker-1', enabled: false, slots: 1, commands: [] }], commands: [] });
  scaffoldHostDefinition(vault, ['command', 'true', '--handler', 'word-count']);
  expect(readHostRegistry(vault).commands).toEqual([{ id: 'true', handler: 'word-count' }]);
});

it('preserves a definition the owner edited', () => {
  const args = ['machine', 'sample'];
  const path = scaffoldHostDefinition(vault, args);
  writeFileSync(path, '# owner edits\n');
  expect(() => scaffoldHostDefinition(vault, args)).toThrow(/already exists/);
  expect(readFileSync(path, 'utf8')).toBe('# owner edits\n');
});

it.each([['machine', '../escape'], ['command', 'render', '--handler', 'shell'], ['command', 'count'], ['machine', 'sample', 'extra']])(
  'rejects invalid arguments before writing (%s, %s)', (...args) => {
    expect(() => scaffoldHostDefinition(vault, args)).toThrow();
    expect(existsSync(join(vault, '.agents'))).toBe(false);
  });

it('rejects a symlinked parent directory', () => {
  symlinkSync(tmpdir(), join(vault, '.agents'));
  expect(() => scaffoldHostDefinition(vault, ['machine', 'sample'])).toThrow(/directory/);
});

it('preserves the legacy roster for migration before creating per-machine files', () => {
  const config = join(vault, '.agents/org/config');
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'machines.yaml'), 'machines: {}\n');
  expect(() => scaffoldHostDefinition(vault, ['machine', 'sample'])).toThrow(/legacy/);
  expect(existsSync(join(config, 'machines'))).toBe(false);
});
