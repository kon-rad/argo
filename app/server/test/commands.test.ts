import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliFor, commandsFor, wrapperScript, wrappersFor } from '../src/features/registry.js';

const APP_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * The dispatch table (proposal phase 3): the launcher dispatches `secondbrain <command>`
 * from it, deploy.sh writes each `cli-x` wrapper from it, and cli-features reads it. These
 * checks keep the table honest without needing a database or a config.
 */
describe('the command table', () => {
  it('every command the table lists has an entry file', () => {
    for (const c of commandsFor()) {
      expect(existsSync(resolve(APP_ROOT, 'server/src', c.entry.replace(/\.js$/, '.ts'))), c.command).toBe(true);
    }
  });

  it('command words are unique across the core features and the standalone commands', () => {
    const names = commandsFor().map((c) => c.command);
    expect(new Set(names).size).toBe(names.length);
  });

  it('cliFor finds a core command and a standalone one, and nothing for a bogus word', () => {
    expect(cliFor('board')?.feature?.name).toBe('board');
    expect(cliFor('social')?.cli.entry).toBe('cli-social.js');
    expect(cliFor('social')?.feature, 'a standalone command has no feature').toBeUndefined();
    expect(cliFor('bogus')).toBeUndefined();
  });

  it('the wrappers are a function of the module list: a standalone command wraps only when its module is on', () => {
    expect(wrappersFor(new Set(['board', 'org', 'projects', 'social']))).toEqual(['cli-projects', 'cli-org', 'cli-board', 'cli-social']);
    expect(wrappersFor(new Set(['board']))).toEqual(['cli-board']);
    expect(wrappersFor(new Set())).toEqual([]);
  });

  it('wrapperScript generates what deploy.sh writes, and is undefined for a name no command owns', () => {
    const script = wrapperScript('cli-social');
    expect(script?.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(script).toContain('server/dist/cli-social.js "$@"');
    expect(script, 'render fills @APP_DIR@ at deploy time').toContain('@APP_DIR@');
    expect(wrapperScript('cli-nope')).toBeUndefined();
  });
});
