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
