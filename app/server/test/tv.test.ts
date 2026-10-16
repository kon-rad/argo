import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { parseFlatFrontmatter } from '../src/routes/tv.js';
const EPISODES_DIR = 'tv/episodes';
import { ALL_MODULES, truncateAll } from './helpers.js';

let root: string;
const NOTE = `---
title: "Weekly Report: the week the second brain learned to talk"
show: news
generated_at: 2026-10-15T00:44+09:00
duration_s: 520
voice: am_michael
video: ${EPISODES_DIR}/2026-10-15_weekly-report-42/episode.mp4
b2_path:
kind: tv-episode
---
# Weekly Report
`;

async function index(path: string, ext: string): Promise<void> {
  await query(
    `INSERT INTO vault_files (path,parent_path,name,title,ext,is_markdown,size_bytes,mtime,content_hash,body)
     VALUES ($1,'',$1,$1,$2,$3,1,now(),$1,'')`,
    [path, ext, ext === '.md'],
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tv-'));
  await mkdir(join(root, EPISODES_DIR, '2026-10-15_weekly-report-42'), { recursive: true });
  await mkdir(join(root, EPISODES_DIR, '2026-10-16_research-brief'), { recursive: true });
  await mkdir(join(root, EPISODES_DIR, 'half-rendered'), { recursive: true });
  await writeFile(join(root, EPISODES_DIR, '2026-10-15_weekly-report-42/episode.md'), NOTE);
  await writeFile(join(root, EPISODES_DIR, '2026-10-15_weekly-report-42/episode.mp4'), 'not really video');
  await writeFile(
    join(root, EPISODES_DIR, '2026-10-16_research-brief/episode.md'),
    '---\ntitle: Research brief\nshow: research\ngenerated_at: 2026-10-16T09:00+09:00\nduration_s: 400\n---\n',
  );
  await writeFile(
    join(root, EPISODES_DIR, '2026-10-16_research-brief/episode.mp4.b2.md'),
    '---\nb2_path: vault/tv/episodes/2026-10-16_research-brief/episode.mp4\n---\n',
  );
  // half-rendered has script.json only: no note, so it is not an episode yet.
  await writeFile(join(root, EPISODES_DIR, 'half-rendered/script.json'), '{}');
});

beforeEach(async () => {
  await truncateAll();
});

describe('parseFlatFrontmatter', () => {
  it('reads key: value lines and strips quotes', () => {
    expect(parseFlatFrontmatter(NOTE)).toMatchObject({ title: 'Weekly Report: the week the second brain learned to talk', show: 'news', duration_s: '520', b2_path: '' });
  });
  it('returns nothing without a frontmatter block', () => {
    expect(parseFlatFrontmatter('# just a note\n')).toEqual({});
  });
});

describe('GET /api/tv/episodes', () => {
  it('lists episode notes newest first, playable from disk or from an indexed B2 stub', async () => {
    const app = createApp({ modules: ALL_MODULES, vaultRoot: root });
    const res = await request(app).get('/api/tv/episodes');
    expect(res.status).toBe(200);
    const ids = res.body.episodes.map((e: { id: string }) => e.id);
    expect(ids).toEqual(['2026-10-16_research-brief', '2026-10-15_weekly-report-42']);

    const [brief, report] = res.body.episodes;
    // The stub is not indexed, so the droplet cannot stream it yet: listed, not playable.
    expect(brief).toMatchObject({ show: 'research', duration_s: 400, video: null, source: null });
    expect(report).toMatchObject({
      title: 'Weekly Report: the week the second brain learned to talk',
      show: 'news',
      duration_s: 520,
      voice: 'am_michael',
      source: 'local',
      note: `${EPISODES_DIR}/2026-10-15_weekly-report-42/episode.md`,
    });
    // The MP4 is never in the index (only the droplet scans, and it never has the file), so the Mac serves it itself.
    expect(report.video).toBe('/api/tv/media/2026-10-15_weekly-report-42');
  });

  it('streams through /api/b2 once the stub is indexed and the file is not on disk', async () => {
    await index(`${EPISODES_DIR}/2026-10-16_research-brief/episode.mp4.b2.md`, '.md');
    const app = createApp({ modules: ALL_MODULES, vaultRoot: root });
    const res = await request(app).get('/api/tv/episodes');
    const brief = res.body.episodes.find((e: { id: string }) => e.id === '2026-10-16_research-brief');
    expect(brief.source).toBe('b2');
    expect(brief.video).toBe(`/api/b2?path=${encodeURIComponent(`${EPISODES_DIR}/2026-10-16_research-brief/episode.mp4.b2.md`)}`);
  });

  it('serves the local MP4 whole and by byte range, and refuses anything that is not an episode id', async () => {
    const app = createApp({ modules: ALL_MODULES, vaultRoot: root });
    // superagent does not buffer video/mp4 on its own.
    const bytes = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void): void => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    };
    const whole = await request(app).get('/api/tv/media/2026-10-15_weekly-report-42').buffer(true).parse(bytes);
    expect(whole.status).toBe(200);
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect((whole.body as Buffer).toString()).toBe('not really video');

    const part = await request(app)
      .get('/api/tv/media/2026-10-15_weekly-report-42')
      .set('Range', 'bytes=4-9')
      .buffer(true)
      .parse(bytes);
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 4-9/16');
    expect((part.body as Buffer).toString()).toBe('really');

    const beyond = await request(app).get('/api/tv/media/2026-10-15_weekly-report-42').set('Range', 'bytes=100-');
    expect(beyond.status).toBe(416);

    expect((await request(app).get('/api/tv/media/2026-10-16_research-brief')).status).toBe(404);
    expect((await request(app).get('/api/tv/media/..%2F..%2Fsecret')).status).toBe(400);
  });

  it('answers an empty list when the episodes folder does not exist', async () => {
    const app = createApp({ modules: ALL_MODULES, vaultRoot: await mkdtemp(join(tmpdir(), 'argo-tv-empty-')) });
    const res = await request(app).get('/api/tv/episodes');
    expect(res.status).toBe(200);
    expect(res.body.episodes).toEqual([]);
  });
});
