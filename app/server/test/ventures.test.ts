import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { patchFrom } from '../src/cli-projects.js';
import { query } from '../src/db.js';
import { upsertDivision, upsertProject } from '../src/projects.js';
import { resetSettings } from '../src/settings.js';
import {
  checkHomePath, getVenture, listVentures, readBrand, renderKpis, scaffoldVenture, setProjectVenture,
  upsertVenture, writeKpiFiles,
} from '../src/ventures.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

const vault = mkdtempSync(join(tmpdir(), 'sb-ventures-'));

beforeAll(() => {
  process.env.SECONDBRAIN_SETTINGS = join(vault, 'secondbrain.json');
  writeFileSync(
    process.env.SECONDBRAIN_SETTINGS,
    JSON.stringify({
      ventures: { kinds: ['product', 'brand', 'client'] },
      metrics: [{ key: 'acme.followers', label: 'Acme followers', unit: 'followers', venture: 'acme', target: 1000 }],
    }),
  );
  resetSettings();
});
afterAll(() => {
  delete process.env.SECONDBRAIN_SETTINGS;
  resetSettings();
});
beforeEach(truncateAll);

describe('home_path', () => {
  it('allows Areas/ and Projects/ folders and nothing else', () => {
    expect(checkHomePath('Areas/acme/')).toBe('Areas/acme');
    expect(checkHomePath('Projects/new-startup')).toBe('Projects/new-startup');
    for (const bad of ['/etc/passwd', 'Areas', '../Areas/x', 'Areas/../../x', 'Research/x', 'CURRENT/x']) {
      expect(() => checkHomePath(bad), bad).toThrow(/home_path/);
    }
  });
});

describe('upsertVenture', () => {
  it('creates, updates and keeps kinds to the configured list', async () => {
    await upsertVenture('acme', { name: 'Acme', kind: 'brand', home_path: 'Areas/acme' }, 't', { create: true });
    await upsertVenture('acme', { summary: 'Umbrella', links: [{ label: 'Site', url: 'https://example.com' }], goals: ['Y1'] }, 't');
    const v = (await listVentures(vault))[0]!;
    expect(v).toMatchObject({ slug: 'acme', kind: 'brand', home_path: 'Areas/acme', summary: 'Umbrella', goals: ['Y1'] });
    expect(v.links).toEqual([{ label: 'Site', url: 'https://example.com' }]);
    await expect(upsertVenture('acme', { kind: 'fund' }, 't')).rejects.toThrow(/unknown kind "fund"/);
    await expect(upsertVenture('ghost', { summary: 'x' }, 't')).rejects.toThrow(/no venture/);
    await expect(upsertVenture('nameless', {}, 't', { create: true })).rejects.toThrow(/needs a name/);
  });

  it('nests one level only', async () => {
    await upsertVenture('umbrella', { name: 'Umbrella' }, 't', { create: true });
    await upsertVenture('child', { name: 'Child', parent: 'umbrella' }, 't', { create: true });
    await upsertVenture('grand', { name: 'Grand' }, 't', { create: true });
    await expect(upsertVenture('grand', { parent: 'child' }, 't')).rejects.toThrow(/nest one level/);
    await expect(upsertVenture('umbrella', { parent: 'grand' }, 't')).rejects.toThrow(/has children/);
    await expect(upsertVenture('grand', { parent: 'grand' }, 't')).rejects.toThrow(/own parent/);
    expect((await listVentures(vault)).find((v) => v.slug === 'umbrella')!.children).toEqual(['child']);
  });

  it('works without any division, and checks one when given', async () => {
    await expect(upsertVenture('solo', { name: 'Solo', division: 'nope' }, 't', { create: true })).rejects.toThrow(/no division/);
    await upsertDivision('d1', { name: 'D1' });
    await upsertVenture('solo', { name: 'Solo', division: 'd1' }, 't', { create: true });
    await upsertVenture('solo', { division: null }, 't');
    expect((await listVentures(vault))[0]!.division).toBeNull();
  });
});

describe('projects point at ventures', () => {
  it('through the project patch and setProjectVenture', async () => {
    await upsertVenture('acme', { name: 'Acme' }, 't', { create: true });
    await expect(upsertProject('p1', { title: 'P1', stage: 'idea', venture: 'ghost' }, 't', { create: true })).rejects.toThrow(/no venture/);
    await upsertProject('p1', { title: 'P1', stage: 'idea', venture: 'acme' }, 't', { create: true });
    await upsertProject('p2', { title: 'P2', stage: 'building' }, 't', { create: true });
    await setProjectVenture('p2', 'acme');
    expect((await getVenture(vault, 'acme')).projects.map((p) => p.slug).sort()).toEqual(['p1', 'p2']);
    await setProjectVenture('p2', null);
    expect((await getVenture(vault, 'acme')).projects.map((p) => p.slug)).toEqual(['p1']);
  });
});

describe('home folder and brand', () => {
  it('scaffolds README and brand/, never overwrites, and reads whatever tokens exist', async () => {
    await upsertVenture('acme', { name: 'Acme', kind: 'brand', summary: 'Makes things', home_path: 'Areas/acme' }, 't', { create: true });
    const first = await scaffoldVenture(vault, 'acme');
    expect(first.created.sort()).toEqual(['Areas/acme/README.md', 'Areas/acme/brand/brand.md']);
    expect(readFileSync(join(vault, 'Areas/acme/README.md'), 'utf8')).toContain('# Acme');
    const again = await scaffoldVenture(vault, 'acme');
    expect(again.created).toEqual([]);

    expect(readBrand(vault, 'Areas/acme')!.tokens).toEqual({ venture: 'acme' });
    writeFileSync(join(vault, 'Areas/acme/brand/brand.md'), '---\npalette:\n  ink: "#111111"\nfonts: { heading: Inter }\ncustom_key: 3\n---\nVoice: plain.\n');
    mkdirSync(join(vault, 'Areas/acme/brand/logo'));
    writeFileSync(join(vault, 'Areas/acme/brand/logo/mark.svg'), '<svg/>');
    const b = (await getVenture(vault, 'acme')).brand!;
    expect(b.tokens).toEqual({ palette: { ink: '#111111' }, fonts: { heading: 'Inter' }, custom_key: 3 });
    expect(b.body).toBe('Voice: plain.');
    expect(b.assets.logo).toEqual(['Areas/acme/brand/logo/mark.svg']);
  });

  it('a malformed brand.md does not throw; a venture with no home has no brand', async () => {
    await upsertVenture('b', { name: 'B', home_path: 'Areas/b' }, 't', { create: true });
    mkdirSync(join(vault, 'Areas/b/brand'), { recursive: true });
    writeFileSync(join(vault, 'Areas/b/brand/brand.md'), '---\n: : bad: [\n---\ntext');
    expect((await getVenture(vault, 'b')).brand).not.toBeNull();
    await upsertVenture('c', { name: 'C' }, 't', { create: true });
    expect((await getVenture(vault, 'c')).brand).toBeNull();
    await expect(scaffoldVenture(vault, 'c')).rejects.toThrow(/no home_path/);
  });
});

describe('kpis', () => {
  it('lists the latest sample of metrics tied to the venture and writes kpis.md only on change', async () => {
    await upsertVenture('acme', { name: 'Acme', home_path: 'Areas/acme' }, 't', { create: true });
    mkdirSync(join(vault, 'Areas/acme'), { recursive: true });
    expect((await getVenture(vault, 'acme')).kpis[0]).toMatchObject({ key: 'acme.followers', value: null });
    await query(`INSERT INTO metric_samples (metric, source, value, unit, sampled_at) VALUES
      ('acme.followers','manual',100,'followers','2026-10-01T12:00:00Z'), ('acme.followers','manual',250,'followers','2026-10-20T12:00:00Z')`);
    expect((await getVenture(vault, 'acme')).kpis[0]!.value).toBe(250);
    expect(await writeKpiFiles(vault)).toEqual(['Areas/acme/kpis.md']);
    expect(readFileSync(join(vault, 'Areas/acme/kpis.md'), 'utf8')).toContain('| Acme followers | 250 followers | 1,000 | 2026-10-20 |');
    expect(await writeKpiFiles(vault, new Date('2030-01-01'))).toEqual([]);
    expect(renderKpis('X', [])).toContain('No metrics are tied');
  });
});

describe('/api/ventures', () => {
  const app = () => createApp({ modules: ALL_MODULES, vaultRoot: vault });

  it('lists, creates, scaffolds and reads', async () => {
    await request(app()).put('/api/ventures/api-acme').send({ name: 'Acme', kind: 'brand', home_path: 'Areas/api-acme' }).expect(201);
    await request(app()).put('/api/ventures/api-acme').send({ summary: 'Hi' }).expect(200);
    await request(app()).put('/api/ventures/api-acme').send({ kind: 'nope' }).expect(400);
    await request(app()).put('/api/ventures/api-acme').send({ home_path: '../x/y' }).expect(400);
    await request(app()).put('/api/ventures/api-acme').send({ bogus: 1 }).expect(400);
    const list = await request(app()).get('/api/ventures').expect(200);
    expect(list.body.kinds).toEqual(['product', 'brand', 'client']);
    expect(list.body.ventures[0].slug).toBe('api-acme');
    await request(app()).post('/api/ventures/api-acme/scaffold').expect(200);
    expect(existsSync(join(vault, 'Areas/api-acme/brand/brand.md'))).toBe(true);
    const one = await request(app()).get('/api/ventures/api-acme').expect(200);
    expect(one.body.brand.tokens.venture).toBe('api-acme');
    await request(app()).get('/api/ventures/ghost').expect(404);
  });
});

describe('cli flags', () => {
  it('parse links pairs and home', () => {
    const p = patchFrom(
      { home: 'Areas/x', links: 'Site=https://a.example,Docs=https://b.example/x?y=1', sort: '3' },
      { home: { key: 'home_path', kind: 'text' }, links: { key: 'links', kind: 'links' }, sort: { key: 'sort', kind: 'int' } },
    );
    expect(p).toEqual({ home_path: 'Areas/x', links: [{ label: 'Site', url: 'https://a.example' }, { label: 'Docs', url: 'https://b.example/x?y=1' }], sort: 3 });
  });
});
