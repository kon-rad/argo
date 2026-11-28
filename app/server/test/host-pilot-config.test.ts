import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readHostRegistry } from '../src/hosts/config.js';

let root: string;
let config: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'host-pilot-config-'));
  config = join(root, '.agents', 'org', 'config');
  mkdirSync(join(config, 'commands'), { recursive: true });
  mkdirSync(join(config, 'machines'));
  writeFileSync(join(config, 'commands', 'words.yaml'), 'id: words\nhandler: word-count\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('sorts valid machine definitions by filename', () => {
  for (const id of ['west', 'east'])
    writeFileSync(join(config, 'machines', id + '.yaml'), `id: ${id}\nenabled: true\nslots: 1\ncommands: [words]\n`);
  const result = readHostRegistry(root);
  expect(result.machines.map(machine => machine.id)).toEqual(['east', 'west']);
  expect(result.commands).toEqual([{ id: 'words', handler: 'word-count' }]);
});

it.each([
  ['mismatched filename', 'id: wrong\nhandler: word-count'],
  ['unknown handler', 'id: words\nhandler: shell'],
  ['duplicate key', 'id: words\nid: words\nhandler: word-count'],
  ['unsafe YAML tag', '!!js/function "function () {}"'],
  ['multiple documents', 'id: words\nhandler: word-count\n---\n{}'],
])('rejects %s', (_label, body) => {
  writeFileSync(join(config, 'commands', 'words.yaml'), body);
  expect(() => readHostRegistry(root)).toThrow();
});

it('rejects a reference to an unregistered command', () => {
  writeFileSync(join(config, 'machines', 'test.yaml'), 'id: test\nenabled: true\nslots: 1\ncommands: [missing]');
  expect(() => readHostRegistry(root)).toThrow();
});

it('rejects a linked registry directory', () => {
  rmSync(join(config, 'machines'), { recursive: true });
  symlinkSync(join(config, 'commands'), join(config, 'machines'));
  expect(() => readHostRegistry(root)).toThrow();
});

it('keeps machine routing details outside the scheduler registry', () => {
  const policy = { id: 'sample', enabled: false, slots: 1, commands: [] };
  const path = join(config, 'machines', 'sample.yaml');
  writeFileSync(path, JSON.stringify(policy));
  const original = readHostRegistry(root);
  const routing = { role: 'test worker', ssh: 'sample-alias', worktree_root: '/example/work' };
  writeFileSync(path, JSON.stringify({ ...policy, routing }));
  expect(readHostRegistry(root)).toEqual(original);
});

it.each([
  { routing: { role: true } },
  { routing: { ssh: ['unexpected'] } },
  { routing: { worktree_root: 5 } },
  { routing: { commands: ['words'] } },
  { routing: null },
  { extra: 'unexpected' },
])('rejects malformed machine metadata or policy %#', extra => {
  writeFileSync(join(config, 'machines', 'sample.yaml'),
    JSON.stringify({ id: 'sample', enabled: true, slots: 1, commands: [], ...extra }));
  expect(() => readHostRegistry(root)).toThrow();
});

it('rejects routing fields on command definitions', () => {
  writeFileSync(join(config, 'commands', 'words.yaml'), 'id: words\nhandler: word-count\nrouting: {}');
  expect(() => readHostRegistry(root)).toThrow();
});
