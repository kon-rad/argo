import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAddonList } from '../src/addons/list.js';
import { parseSettings, resetSettings, settings, settingsPath, settingsReport } from '../src/settings.js';

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

  it('resolves the default and absolute settings paths', () => {
    const vault = mkdtempSync(join(tmpdir(), 'sb-settings-'));
    delete process.env.SECONDBRAIN_SETTINGS;
    expect(settingsPath(vault)).toBe(join(vault, 'secondbrain.json'));

    const alternate = join(vault, 'brain.json');
    writeFileSync(alternate, JSON.stringify({ livestream: { twitch: 'example' } }), { flag: 'w' });
    process.env.SECONDBRAIN_SETTINGS = alternate;
    expect(isAbsolute(settingsPath(vault))).toBe(true);
    expect(settingsPath(vault)).toBe(alternate);
    expect(settings(vault).livestream.twitch).toBe('example');
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
    expect(err).toHaveBeenCalled();
    expect(err.mock.calls.every(([message]) => String(message).includes('metrics'))).toBe(true);
  });

  it('SECONDBRAIN_SETTINGS points elsewhere, relative to the vault', () => {
    const vault = mkdtempSync(join(tmpdir(), 'sb-settings-'));
    writeFileSync(join(vault, 'other.json'), JSON.stringify({ livestream: { kick: 'someone' } }));
    process.env.SECONDBRAIN_SETTINGS = 'other.json';
    resetSettings();
    expect(settings(vault).livestream.kick).toBe('someone');
  });

  it('reads the addon list from SECONDBRAIN_SETTINGS', () => {
    const vault = mkdtempSync(join(tmpdir(), 'sb-settings-'));
    writeFileSync(join(vault, 'alternate.json'), JSON.stringify({ addons: ['map', 'voice'] }));
    process.env.SECONDBRAIN_SETTINGS = 'alternate.json';
    expect(readAddonList(vault)).toEqual(['map', 'voice']);
  });

  it('keeps valid sections when one section is invalid and reports its field', () => {
    const report = settingsReport({
      summaries: { minSteps: 7 },
      socialMetrics: { staleHours: -1 },
    });
    expect(report.settings.summaries.minSteps).toBe(7);
    expect(report.settings.socialMetrics.staleHours).toBe(36);
    expect(report.errors).toEqual([
      expect.objectContaining({ section: 'socialMetrics', path: ['socialMetrics', 'staleHours'] }),
    ]);
    expect(report.errors[0]?.message).toMatch(/>0/);
  });
});
