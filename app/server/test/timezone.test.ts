import { chmodSync, chownSync, fchownSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { ALL_MODULES } from './helpers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runTimezone } from '../src/cli-timezone.js';
import { parseSettings, resetSettings, settings } from '../src/settings.js';
import { canonicalTimeZone, currentTimezone, isTimeZone, saveTimezone, withTimezone } from '../src/timezone.js';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, fchownSync: vi.fn(fs.fchownSync) };
});

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
    for (const tz of ['America/Los_Angeles', 'America/New_York', 'Asia/Singapore', 'UTC', 'Europe/London']) expect(isTimeZone(tz), tz).toBe(true);
    for (const tz of ['', 'Mars/Olympus', 'PST8PDT; rm -rf /', '+05:30', 'not a zone', 'EST', 'CET', 'GMT', 'GMT0', 'EST5EDT', 'Etc/GMT+5', 'Etc/UTC', 'SystemV/EST5', 42, null]) expect(isTimeZone(tz), String(tz)).toBe(false);
    expect(canonicalTimeZone('asia/singapore')).toBe('Asia/Singapore');
    expect(canonicalTimeZone('Mars/Olympus')).toBeNull();
  });

  it('rejects legacy abbreviations and fixed aliases in CLI and settings without changing the file', () => {
    saveTimezone('America/New_York', file);
    const before = statSync(file);
    const text = readFileSync(file, 'utf8');
    for (const alias of ['EST', 'CET', 'GMT', 'GMT0', 'EST5EDT', 'Etc/GMT+5', 'Etc/UTC', 'SystemV/EST5']) {
      const errors: string[] = [];
      expect(runTimezone(['set', alias], { path: file, out: () => {}, err: (line) => errors.push(line) }), alias).toBe(2);
      expect(errors.join('\n')).toMatch(/not an IANA time zone/);
      expect(canonicalTimeZone(alias), alias).toBeNull();
      expect(readFileSync(file, 'utf8'), alias).toBe(text);
      expect(statSync(file).ino, alias).toBe(before.ino);
      const parsed = parseSettings({ timezone: alias, usage: { credits: ['fal'] } });
      expect(parsed.timezone, alias).toBeUndefined();
      expect(parsed.usage.credits).toEqual(['fal']);
    }
  });

  it.each([
    ['2026-03-08T06:59:00Z', '01:59', 'GMT-5'],
    ['2026-03-08T07:01:00Z', '03:01', 'GMT-4'],
    ['2026-11-01T05:59:00Z', '01:59', 'GMT-4'],
    ['2026-11-01T06:01:00Z', '01:01', 'GMT-5'],
  ])('keeps New York DST semantics at %s', (at, clock, offset) => {
    saveTimezone('America/New_York', file);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: currentTimezone(file)!, hour: '2-digit',
      minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }).formatToParts(new Date(at));
    expect(parts.filter((p) => p.type === 'hour' || p.type === 'minute').map((p) => p.value).join(':')).toBe(clock);
    expect(parts.find((p) => p.type === 'timeZoneName')?.value).toBe(offset);
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

  it('preserves owner, service group and 0640 access when setting and clearing', (context) => {
    const uid = process.getuid?.();
    const groups = process.getgroups?.() ?? [];
    const original = statSync(file);
    const group = groups.find((gid) => gid !== original.gid);
    if (uid === undefined || uid === 0 || group === undefined) {
      console.info('SKIP: unprivileged distinct supplementary-group scenario is unavailable');
      context.skip();
      return;
    }
    expect(uid).toBeGreaterThan(0);
    expect(original.uid).toBe(uid);
    expect(group).not.toBe(original.gid);
    chownSync(file, original.uid, group);
    chmodSync(file, 0o640);
    console.info('Verified unprivileged distinct supplementary-group scenario', { uid, originalGid: original.gid, serviceGid: group });
    const identity = () => { const s = statSync(file); return { uid: s.uid, gid: s.gid, mode: s.mode & 0o777 }; };
    const expected = { uid: original.uid, gid: group, mode: 0o640 };
    saveTimezone('Asia/Singapore', file);
    expect(identity()).toEqual(expected);
    expect(currentTimezone(file)).toBe('Asia/Singapore');
    saveTimezone(null, file);
    expect(identity()).toEqual(expected);
    expect(currentTimezone(file)).toBeNull();
  });

  it('leaves the original file untouched when ownership cannot be retained', () => {
    chmodSync(file, 0o640);
    const before = statSync(file);
    const text = readFileSync(file, 'utf8');
    const parent = join(file, '..');
    vi.mocked(fchownSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    expect(() => saveTimezone('Asia/Singapore', file)).toThrow(/ownership|owner|identity/i);
    expect(readFileSync(file, 'utf8')).toBe(text);
    const after = statSync(file);
    expect([after.ino, after.uid, after.gid, after.mode]).toEqual([before.ino, before.uid, before.gid, before.mode]);
    expect(readdirSync(parent)).toEqual(['secondbrain.json']);
    expect(currentTimezone(file)).toBeNull();
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

  it('/api/meta serves the zone and picks up a change without a restart; null when unset', async () => {
    const app = createApp({ modules: ALL_MODULES });
    expect((await request(app).get('/api/meta').expect(200)).body.timezone).toBeNull();
    saveTimezone('Asia/Singapore', file);
    expect((await request(app).get('/api/meta').expect(200)).body.timezone).toBe('Asia/Singapore');
    saveTimezone(null, file);
    expect((await request(app).get('/api/meta').expect(200)).body.timezone).toBeNull();
  });
});
