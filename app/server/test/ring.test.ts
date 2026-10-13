import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { DUMP_SQL, type RingDump } from '../src/ring.js';
import { truncateAll } from './helpers.js';

const DAY = '2026-10-10';

function dump(score: number): RingDump {
  return {
    ring_raw: [
      {
        day: DAY,
        payload: [{ type: 'sleep', object: { sleep_score: { score: score } } }],
        payload_sha256: 'abc',
        received_at: '2026-10-11T06:00:00+00:00',
        changed_at: '2026-10-11T06:00:00+00:00',
      },
    ],
    ring_daily: [{ day: DAY, sleep_score: score, total_sleep_min: 420, deep_min: 80, hrv_avg: 55.5 }],
    ring_samples: [
      { metric: 'sleep_hr', ts: 1791000000, day: DAY, value: 52 },
      { metric: 'sleep_hr', ts: 1791000300, day: DAY, value: 50 },
      { metric: 'hr', ts: 1791000600, day: DAY, value: 70 },
    ],
    ring_sleep_stages: [
      { day: DAY, start: 1791000000, end: 1791001800, stage: 'light_sleep' },
      { day: DAY, start: 1791001800, end: 1791003600, stage: 'deep_sleep' },
    ],
  };
}

let pulls: string[] = [];
let next: RingDump | Error = dump(81);
const fetchDump = async (host: string, db: string): Promise<RingDump> => {
  pulls.push(`${host}/${db}`);
  if (next instanceof Error) throw next;
  return next;
};

const local = createApp({ ring: { host: 'droplet', db: 'secondbrain', fetchDump } });

beforeEach(async () => {
  await truncateAll();
  pulls = [];
  next = dump(81);
});

describe('ring pull (Mac)', () => {
  it('mirrors the droplet tables, then the overview and night views read them', async () => {
    const res = await request(local).post('/api/ring/pull');
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ ring_raw: 1, ring_daily: 1, ring_samples: 3, ring_sleep_stages: 2 });
    expect(pulls).toEqual(['droplet/secondbrain']);

    const overview = await request(local).get('/api/ring');
    expect(overview.body.can_pull).toBe(true);
    expect(overview.body.total_days).toBe(1);
    expect(overview.body.days[0]).toMatchObject({ day: DAY, sleep_score: 81, total_sleep_min: 420 });

    const night = await request(local).get(`/api/ring/night/${DAY}`);
    expect(night.status).toBe(200);
    expect(night.body.stages.map((s: { stage: string }) => s.stage)).toEqual(['light_sleep', 'deep_sleep']);
    // Only the in-bed series, not daytime heart rate.
    expect(night.body.heart_rate).toHaveLength(2);

    const raw = await query<{ payload: unknown }>('SELECT payload FROM ring_raw');
    expect(raw.rows[0]!.payload).toEqual([{ type: 'sleep', object: { sleep_score: { score: 81 } } }]);
  });

  it('replaces rather than appends, so a revised night overwrites the old one', async () => {
    await request(local).post('/api/ring/pull');
    next = dump(64);
    await request(local).post('/api/ring/pull');
    const { rows } = await query<{ n: number; score: number }>(
      'SELECT count(*)::int AS n, max(sleep_score) AS score FROM ring_daily',
    );
    expect(rows[0]).toEqual({ n: 1, score: 64 });
  });

  it('keeps the old mirror when the pull fails', async () => {
    await request(local).post('/api/ring/pull');
    next = new Error('ssh droplet failed: timed out');
    const res = await request(local).post('/api/ring/pull');
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/timed out/);
    expect((await request(local).get('/api/ring')).body.total_days).toBe(1);
  });

  it('rejects a malformed dump without touching the tables', async () => {
    await request(local).post('/api/ring/pull');
    next = { ring_raw: [] } as unknown as RingDump;
    expect((await request(local).post('/api/ring/pull')).status).toBe(502);
    expect((await request(local).get('/api/ring')).body.total_days).toBe(1);
  });

  it('404s an unknown night and 400s a bad date', async () => {
    expect((await request(local).get('/api/ring/night/2026-01-01')).status).toBe(404);
    expect((await request(local).get('/api/ring/night/yesterday')).status).toBe(400);
  });

  it('dumps every ring table in one statement', () => {
    for (const t of ['ring_raw', 'ring_daily', 'ring_samples', 'ring_sleep_stages']) {
      expect(DUMP_SQL).toContain(`FROM ${t} x`);
    }
  });
});

describe('ring on the server', () => {
  const server = createApp({
    deployment: 'server',
    auth: { passwordHash: 'x', totpSecret: 'JBSWY3DPEHPK3PXP', publicOrigin: 'https://example.test' },
    ring: { fetchDump },
  });

  it('needs a session like every other route', async () => {
    expect((await request(server).get('/api/ring')).status).toBe(401);
  });
});
