import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import type { Connector, RunContext } from '../src/connectors/types.js';
import { vaultConnector } from '../src/connectors/vault/scan.js';
import { truncateAll, vaultSourceId } from './helpers.js';

let root: string;
let vaultId: number;
let slowId: number;

/**
 * A connector the test can hold open. Concurrency and progress are only
 * observable while a job is still running, and a real scan of a fixture
 * finishes in milliseconds — far too fast to catch from the outside.
 */
let release: (() => void) | null = null;
let started: Promise<void>;
let markStarted: () => void;

const slowConnector: Connector = {
  id: 'slow',
  configSchema: z.object({}).passthrough(),
  async run(ctx: RunContext) {
    ctx.onProgress({ phase: 'working', filesSeen: 7 });
    markStarted();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { done: true };
  },
};

function armSlowConnector(): void {
  release = null;
  started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
}

const app = createApp({ connectors: { vault: vaultConnector, slow: slowConnector } });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'sources-'));
  await mkdir(join(root, 'notes'), { recursive: true });
  await writeFile(join(root, 'notes/alpha.md'), '# Alpha\n\nhello\n');
  await writeFile(join(root, 'notes/beta.md'), '# Beta\n\nworld\n');

  vaultId = await vaultSourceId();
  await query(`UPDATE sources SET config = config || $2::jsonb WHERE id = $1`, [
    vaultId,
    JSON.stringify({ root }),
  ]);
  const { rows } = await query<{ id: number }>(
    `INSERT INTO sources (kind, name) VALUES ('slow','Slow') RETURNING id`,
  );
  slowId = rows[0]!.id;
});

afterAll(async () => {
  release?.();
  await query(`DELETE FROM sources WHERE kind = 'slow'`);
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await truncateAll();
  armSlowConnector();
});

describe('sources and runs API', () => {
  it('GET /api/sources lists the seeded vault source', async () => {
    const res = await request(app).get('/api/sources');
    expect(res.status).toBe(200);
    const vault = res.body.sources.find((s: { kind: string }) => s.kind === 'vault');
    expect(vault).toBeDefined();
    expect(vault.name).toBe('Vault');
    expect(vault.enabled).toBe(true);
    expect(vault.last_run).toBeNull();
  });

  it('the last_run summary carries every field the runs list has', async () => {
    // The Sources screen renders last_run with the same component it renders a
    // live run with, so a summary missing `progress` crashes the page.
    const started = await request(app).post(`/api/sources/${vaultId}/sync`);
    await waitForRun(started.body.run_id, 'ok');

    const res = await request(app).get('/api/sources');
    const vault = res.body.sources.find((s: { kind: string }) => s.kind === 'vault');
    expect(Object.keys(vault.last_run).sort()).toEqual(
      ['error', 'finished_at', 'id', 'progress', 'source_id', 'started_at', 'stats', 'status'],
    );
  });

  it('POST /api/sources/:id/sync returns 202 with a run id and really scans', async () => {
    const res = await request(app).post(`/api/sources/${vaultId}/sync`);
    expect(res.status).toBe(202);
    expect(typeof res.body.run_id).toBe('number');

    await waitForRun(res.body.run_id, 'ok');

    const { rows } = await query<{ count: number }>(`SELECT count(*)::int FROM vault_files`);
    expect(rows[0]!.count).toBe(2);
  });

  it('a second concurrent sync returns 409 with the SAME run id', async () => {
    const a = await request(app).post(`/api/sources/${slowId}/sync`);
    const b = await request(app).post(`/api/sources/${slowId}/sync`);
    expect(a.status).toBe(202);
    expect(b.status).toBe(409);
    expect(b.body.run_id).toBe(a.body.run_id);

    release?.();
    await waitForRun(a.body.run_id, 'ok');
  });

  it('two syncs fired without awaiting create exactly one run', async () => {
    const [a, b] = await Promise.all([
      request(app).post(`/api/sources/${slowId}/sync`),
      request(app).post(`/api/sources/${slowId}/sync`),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 409]);
    expect(a.body.run_id).toBe(b.body.run_id);

    const { rows } = await query<{ count: number }>(
      `SELECT count(*)::int FROM ingest_runs WHERE source_id = $1`,
      [slowId],
    );
    expect(rows[0]!.count).toBe(1);

    release?.();
    await waitForRun(a.body.run_id, 'ok');
  });

  it('GET /api/runs?active=1 reports progress while running', async () => {
    const res = await request(app).post(`/api/sources/${slowId}/sync`);
    await started;

    // The progress write is deliberately fire-and-forget inside the runner, so
    // poll for it rather than assuming it landed before the connector resumed.
    const active = await pollActive(res.body.run_id);
    expect(active.status).toBe('running');
    expect(active.progress.phase).toBe('working');
    expect(active.progress.filesSeen).toBe(7);

    release?.();
    await waitForRun(res.body.run_id, 'ok');

    const after = await request(app).get('/api/runs').query({ active: '1' });
    expect(after.body.runs).toHaveLength(0);
  });

  it('records a failed run as status error with the message', async () => {
    const boom = createApp({
      connectors: {
        slow: {
          id: 'slow',
          configSchema: z.object({}).passthrough(),
          run: async () => {
            throw new Error('connector exploded');
          },
        },
      },
    });
    const res = await request(boom).post(`/api/sources/${slowId}/sync`);
    expect(res.status).toBe(202);
    const row = await waitForRun(res.body.run_id, 'error');
    expect(row.error).toContain('connector exploded');
  });

  it('PATCH /api/sources/:id updates config and enabled', async () => {
    const res = await request(app)
      .patch(`/api/sources/${slowId}`)
      .send({ enabled: false, config: { hello: 'world' } });
    expect(res.status).toBe(200);
    expect(res.body.source.enabled).toBe(false);
    expect(res.body.source.config).toEqual({ hello: 'world' });

    await request(app).patch(`/api/sources/${slowId}`).send({ enabled: true });
  });

  it('PATCH /api/sources/:id rejects an unknown field with 400', async () => {
    const res = await request(app).patch(`/api/sources/${slowId}`).send({ nope: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('POST /api/sources/:id/sync on an unknown source is 404', async () => {
    const res = await request(app).post('/api/sources/999999/sync');
    expect(res.status).toBe(404);
  });

  it('POST /api/sources/:id/sync on a disabled source is 409', async () => {
    await query(`UPDATE sources SET enabled = false WHERE id = $1`, [slowId]);
    const res = await request(app).post(`/api/sources/${slowId}/sync`);
    expect(res.status).toBe(409);
    await query(`UPDATE sources SET enabled = true WHERE id = $1`, [slowId]);
  });
});

interface RunRow {
  id: number;
  status: string;
  error: string | null;
  stats: Record<string, unknown>;
}

interface ActiveRunRow {
  id: number;
  status: string;
  progress: Record<string, unknown>;
}

async function pollActive(id: number): Promise<ActiveRunRow> {
  for (let i = 0; i < 300; i++) {
    const res = await request(app).get('/api/runs').query({ active: '1' });
    const row = res.body.runs.find((r: ActiveRunRow) => r.id === id);
    if (row && row.progress?.['phase']) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`run ${id} never reported progress`);
}

async function waitForRun(id: number, status: string): Promise<RunRow> {
  for (let i = 0; i < 300; i++) {
    const { rows } = await query<RunRow>(
      `SELECT id, status, error, stats FROM ingest_runs WHERE id = $1`,
      [id],
    );
    if (rows[0] && rows[0].status === status) return rows[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`run ${id} never reached status ${status}`);
}
