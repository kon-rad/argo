import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { MODULE_NAMES, modulesFromEnv } from '../src/config.js';
import { FEATURES } from '../src/features/index.js';
import { MANIFESTS, cliFor, navFor, unitsFor, wrappersFor } from '../src/features/registry.js';

const APP_ROOT = resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = resolve(APP_ROOT, '..');

describe('feature manifests', () => {
  it('every manifest names a known module once, and every feature has routes', () => {
    const names = MANIFESTS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(MODULE_NAMES).toContain(name);
    expect(FEATURES.map((f) => f.name)).toEqual(names);
  });

  it('every file a manifest names exists: CLI entries, unit pairs, wrappers and docs', () => {
    for (const m of MANIFESTS) {
      for (const c of m.cli) expect(existsSync(resolve(APP_ROOT, 'server/src', c.entry.replace(/\.js$/, '.ts'))), `${m.name}: ${c.entry}`).toBe(true);
      for (const t of m.timers) {
        expect(existsSync(resolve(APP_ROOT, 'deploy', `${t.unit}.service`)), `${m.name}: ${t.unit}.service`).toBe(true);
        expect(existsSync(resolve(APP_ROOT, 'deploy', `${t.unit}.timer`)), `${m.name}: ${t.unit}.timer`).toBe(true);
      }
      for (const w of m.wrappers) expect(existsSync(resolve(APP_ROOT, 'deploy/bin', w)), `${m.name}: wrapper ${w}`).toBe(true);
      expect(existsSync(resolve(REPO_ROOT, m.docs.split('#')[0]!)), `${m.name}: ${m.docs}`).toBe(true);
    }
  });

  it('commands, nav paths and units are unique across features', () => {
    const commands = MANIFESTS.flatMap((m) => m.cli.map((c) => c.command));
    expect(new Set(commands).size).toBe(commands.length);
    const paths = MANIFESTS.flatMap((m) => m.nav.map((n) => n.path));
    expect(new Set(paths).size).toBe(paths.length);
    const units = MANIFESTS.flatMap((m) => m.timers.map((t) => t.unit));
    expect(new Set(units).size).toBe(units.length);
  });

  it('answers the deploy script and the launcher for a module list', () => {
    expect(unitsFor(new Set(['board', 'projects']))).toEqual(['secondbrain-projects-render', 'secondbrain-board-reclaim']);
    expect(unitsFor(new Set())).toEqual([]);
    expect(wrappersFor(new Set(['org', 'usage']))).toEqual(['cli-org']);
    expect(navFor(new Set(['usage', 'summaries']))).toEqual([{ section: 'Work', label: 'Usage', path: '/usage' }]);
    expect(cliFor('board')?.feature.name).toBe('board');
    expect(cliFor('summarize')?.cli.entry).toBe('cli-summarize.js');
    expect(cliFor('bogus')).toBeUndefined();
  });

  it('SUMMARIES=on still turns the summaries module on, for one release', () => {
    expect([...modulesFromEnv('usage', 'on')]).toEqual(['usage', 'summaries']);
    expect([...modulesFromEnv('usage,summaries', 'on')]).toEqual(['usage', 'summaries']);
    expect([...modulesFromEnv('usage', undefined)]).toEqual(['usage']);
  });
});

describe('features mounted from their manifests', () => {
  it('a feature that is off leaves no route, and one that is on mounts all of its routes', async () => {
    const off = createApp({ modules: new Set() });
    for (const path of ['/api/projects/report', '/api/feed/projects', '/api/org/channels', '/api/board/cards', '/api/usage/plan', '/api/summaries', '/api/ingest']) {
      const res = await request(off).get(path);
      expect(res.body.error?.message, path).toBe('no such endpoint');
    }
    const on = createApp({ modules: new Set(['summaries']) });
    expect((await request(on).get('/api/summaries')).status, 'summaries alone, without usage').toBe(200);
    expect((await request(on).get('/api/usage/plan')).body.error?.message).toBe('no such endpoint');
  });

  it('the raw mount point reads the ingest body ahead of the global parser', async () => {
    const app = createApp({ modules: new Set(['usage']) });
    // No device token: the router answers 401 itself, which proves it was reached before the 1 MB parser.
    const res = await request(app).post('/api/ingest/batch').set('content-type', 'application/json').send(JSON.stringify({ runs: [] }));
    expect(res.status).toBe(401);
  });

  it('/api/meta lists the nav links of the features that are on', async () => {
    const res = await request(createApp({ modules: new Set(['board', 'org', 'ring']) })).get('/api/meta');
    expect(res.body.nav).toEqual([
      { section: 'Work', label: 'Org', path: '/org' },
      { section: 'Work', label: 'Board', path: '/board' },
    ]);
    const none = await request(createApp({ modules: new Set(['ring']) })).get('/api/meta');
    expect(none.body.nav).toEqual([]);
  });
});
