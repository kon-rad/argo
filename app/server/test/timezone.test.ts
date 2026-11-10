import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTimezone } from '../src/cli-timezone.js';
import { parseSettings, resetSettings, settings } from '../src/settings.js';
import { canonicalTimeZone, currentTimezone, isTimeZone, saveTimezone, withTimezone } from '../src/timezone.js';

let file: string;
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'tz-')), 'secondbrain.json');
  writeFileSync(file, JSON.stringify({ telegram: { bots: [{ name: 'claude', agent: 'claude-code' }] }, usage: { credits: ['fal'] } }, null, 2));
  process.env.SECONDBRAIN_SETTINGS = file;
  resetSettings();
});
afterEach(() => { delete process.env.SECONDBRAIN_SETTINGS; resetSettings(); });

describe('time zone setting', () => {
  it('accepts IANA names only', () => {
    for (const tz of ['America/Los_Angeles', 'Asia/Singapore', 'UTC', 'Europe/London']) expect(isTimeZone(tz), tz).toBe(true);
    for (const tz of ['', 'Mars/Olympus', 'PST8PDT; rm -rf /', '+05:30', 'not a zone', 42, null]) expect(isTimeZone(tz), String(tz)).toBe(false);
    expect(canonicalTimeZone('asia/singapore')).toBe('Asia/Singapore');
    expect(canonicalTimeZone('Mars/Olympus')).toBeNull();
  });

  it('persists in secondbrain.json, keeping every other key, and reads back fresh', () => {
    expect(currentTimezone(file)).toBeNull();
    expect(saveTimezone('America/Los_Angeles', file)).toBe('America/Los_Angeles');
    expect(currentTimezone(file)).toBe('America/Los_Angeles');
    expect(saveTimezone('Asia/Singapore', file)).toBe('Asia/Singapore');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved).toEqual({ telegram: { bots: [{ name: 'claude', agent: 'claude-code' }] }, usage: { credits: ['fal'] }, timezone: 'Asia/Singapore' });
    expect(() => saveTimezone('Mars/Olympus', file)).toThrow(/not an IANA time zone/);
    expect(currentTimezone(file)).toBe('Asia/Singapore'); // a refused value changes nothing
    saveTimezone(null, file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('timezone');
    expect(withTimezone(null, 'UTC')).toBe('{\n  "timezone": "UTC"\n}\n');
  });

  it('preserves restrictive settings permissions across atomic updates and clearing', () => {
    chmodSync(file, 0o600);
    saveTimezone('Asia/Singapore', file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).usage).toEqual({ credits: ['fal'] });
    saveTimezone(null, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('a typo in the file drops the zone, not the rest of the settings', () => {
    const s = parseSettings({ timezone: 'Asia/Singapur', telegram: { bots: [{ name: 'claude', agent: 'claude-code' }] } });
    expect(s.timezone).toBeUndefined();
    expect(s.telegram.bots).toHaveLength(1);
    expect(parseSettings({ timezone: 'Asia/Singapore' }).timezone).toBe('Asia/Singapore');
    writeFileSync(file, JSON.stringify({ timezone: 'Asia/Singapur' }));
    expect(currentTimezone(file)).toBeNull();
    resetSettings();
    expect(settings().timezone).toBeUndefined();
  });

  it('the CLI an agent runs when travelling', () => {
    const out: string[] = []; const err: string[] = [];
    const run = (...argv: string[]) => runTimezone(argv, { path: file, out: (l) => out.push(l), err: (l) => err.push(l) });
    expect(run()).toBe(0);
    expect(out.pop()).toBe('timezone: not set (each browser uses its own zone)');
    expect(run('set', 'America/Los_Angeles')).toBe(0);
    expect(run('set', 'Asia/Singapore')).toBe(0);
    expect(out.pop()).toBe('timezone: America/Los_Angeles -> Asia/Singapore');
    expect(run('show', '--json')).toBe(0);
    expect(JSON.parse(out.pop()!)).toMatchObject({ timezone: 'Asia/Singapore' });
    expect(run('set', 'Singapore/Downtown')).toBe(2);
    expect(err.pop()).toMatch(/not an IANA time zone/);
    expect(run('set')).toBe(2);
    expect(run('travel')).toBe(2);
    expect(currentTimezone(file)).toBe('Asia/Singapore');
    expect(run('clear')).toBe(0);
    expect(out.pop()).toBe('timezone: not set (each browser uses its own zone), was Asia/Singapore');
  });

});
