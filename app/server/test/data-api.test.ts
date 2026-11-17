import express from 'express';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { dataRouter } from '../src/addons/data/routes.js';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { resetDataSchema } from './data-helpers.js';

let vault: string;
let app: express.Express;

beforeEach(async () => {
  await resetDataSchema();
  await query(`CREATE TABLE data.things (id text PRIMARY KEY, n int)`);
  await query(`INSERT INTO data.things VALUES ('a', 1), ('b', 2)`);
  vault = mkdtempSync(join(tmpdir(), 'data-api-'));
  const conn = join(vault, 'data', 'connectors', 'things');
  mkdirSync(conn, { recursive: true });
  writeFileSync(join(conn, 'connector.json'), JSON.stringify({ name: 'things', command: ['true'], tables: ['things'], env: ['DATA_TEST_MISSING_KEY'], schedule: { every: '1d', at: '03:10' } }));
  mkdirSync(join(vault, 'data', 'connectors', 'broken'));
  writeFileSync(join(vault, 'data', 'connectors', 'broken', 'connector.json'), '{');
  mkdirSync(join(vault, 'data', 'dashboards'), { recursive: true });
  writeFileSync(join(vault, 'data', 'dashboards', 'main.json'), JSON.stringify({
    title: 'Main',
    panels: [
      { title: 'Count', chart: 'number', sql: 'select count(*) from data.things' },
      { title: 'Bad', chart: 'table', sql: 'select nope from data.things' },
    ],
  }));
  app = express();
  app.use('/api/data', dataRouter(vault, new Set(['projects', 'data'])));
});

describe('/api/data', () => {
  it('lists data tables first with exact counts and their connector owner, plus engine tables', async () => {
    const { body } = await request(app).get('/api/data/tables').expect(200);
    expect(body.tables[0]).toMatchObject({ schema: 'data', name: 'things', rows: 2, rowsEstimated: false, owner: 'connector:things' });
    expect(body.tables.some((t: { schema: string; name: string }) => t.schema === 'public' && t.name === 'projects')).toBe(true);
  });

  it('shows columns and latest rows for a data table, 404 for an unknown one', async () => {
    const { body } = await request(app).get('/api/data/tables/data/things').expect(200);
    expect(body.columns).toEqual([
      { name: 'id', type: 'text', nullable: false, key: true },
      { name: 'n', type: 'integer', nullable: true, key: false },
    ]);
    expect(body.latest.rows).toEqual([['b', 2], ['a', 1]]);
    const engine = await request(app).get('/api/data/tables/public/projects').expect(200);
    expect(engine.body.latest).toBeNull();
    await request(app).get('/api/data/tables/data/nope').expect(404);
  });

  it('lists connectors with missing env keys, next due, and broken definitions', async () => {
    const { body } = await request(app).get('/api/data/connectors').expect(200);
    expect(body.connectors).toHaveLength(1);
    expect(body.connectors[0]).toMatchObject({ name: 'things', missingEnv: ['DATA_TEST_MISSING_KEY'], lastRuns: [], runCommand: 'secondbrain data run things' });
    expect(body.connectors[0].nextDue).toMatch(/T03:10:00.000Z$/);
    expect(body.errors.map((e: { name: string }) => e.name)).toEqual(['broken']);
  });

  it('lists jobs: connector schedules and enabled modules timers', async () => {
    const { body } = await request(app).get('/api/data/jobs').expect(200);
    expect(body.jobs[0]).toMatchObject({ kind: 'connector', name: 'things', schedule: 'every 1d at 03:10 UTC' });
    expect(body.jobs.some((j: { name: string }) => j.name === 'secondbrain-data-run')).toBe(true);
  });

  it('overview counts sizes and connector states', async () => {
    const { body } = await request(app).get('/api/data/overview').expect(200);
    expect(body).toMatchObject({ dataTables: 1, connectors: { total: 1, never: 1, ok: 0, failing: 0, broken: 1 } });
    expect(body.dbBytes).toBeGreaterThan(body.dataBytes);
  });

  it('renders a dashboard; a bad panel carries its error and the rest still render', async () => {
    expect((await request(app).get('/api/data/dashboards').expect(200)).body.dashboards).toEqual([{ name: 'main', title: 'Main' }]);
    const { body } = await request(app).get('/api/data/dashboards/main').expect(200);
    expect(body.panels[0].result.rows).toEqual([[2]]);
    expect(body.panels[1].error).toMatch(/nope/);
    await request(app).get('/api/data/dashboards/missing').expect(404);
  });

  it('is not mounted when the addon is off', async () => {
    await request(createApp({ modules: new Set(['projects']) })).get('/api/data/overview').expect(404);
  });
});
