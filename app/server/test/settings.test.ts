import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSettings, resetSettings, settings } from '../src/settings.js';

const EXAMPLE = resolve(import.meta.dirname, '..', '..', '..', 'vault-template', 'secondbrain.example.json');

describe('secondbrain.json', () => {
  const saved = process.env.SECONDBRAIN_SETTINGS;
  afterEach(() => {
    if (saved === undefined) delete process.env.SECONDBRAIN_SETTINGS;
    else process.env.SECONDBRAIN_SETTINGS = saved;
    resetSettings();
    vi.restoreAllMocks();
  });

  it('defaults to nothing configured', () => {
    const s = parseSettings({});
    expect(s.metrics).toEqual([]);
    expect(s.map).toEqual({ divisionFolders: {}, missionFolders: [] });
    expect(s.tv).toEqual({ episodesDir: 'tv/episodes', shows: {} });
    expect(s.projects.reportFile).toBe('projects.md');
    expect(s.goalsFile).toBeUndefined();
  });

  it('parses the vault template example', () => {
    const s = parseSettings(JSON.parse(readFileSync(EXAMPLE, 'utf8')));
    expect(s.metrics.map((m) => m.key)).toEqual(['followers.total', 'yt.example.subscribers', 'x.example.followers']);
    expect(s.metrics[0]!.headline).toBe(true);
    expect(s.metrics[1]!.money).toBe(false);
  });

  it('a vault without the file gets the defaults; a broken file is reported and ignored', () => {
    const vault = mkdtempSync(join(tmpdir(), 'sb-settings-'));
    delete process.env.SECONDBRAIN_SETTINGS;
    resetSettings();
    expect(settings(vault).metrics).toEqual([]);

    writeFileSync(join(vault, 'secondbrain.json'), '{ "metrics": [ { "key": "Bad Key" } ] }');
    resetSettings();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(settings(vault).metrics).toEqual([]);
    expect(err).toHaveBeenCalledOnce();
  });

  it('SECONDBRAIN_SETTINGS points elsewhere, relative to the vault', () => {
    const vault = mkdtempSync(join(tmpdir(), 'sb-settings-'));
    writeFileSync(join(vault, 'other.json'), JSON.stringify({ livestream: { kick: 'someone' } }));
    process.env.SECONDBRAIN_SETTINGS = 'other.json';
    resetSettings();
    expect(settings(vault).livestream.kick).toBe('someone');
  });
});
