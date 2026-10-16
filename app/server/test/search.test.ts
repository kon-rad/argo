import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { scanVault } from '../src/connectors/vault/scan.js';
import { truncateAll, vaultSourceId } from './helpers.js';

let root: string;
let app: ReturnType<typeof createApp>;

interface Hit {
  source_kind: string;
  ref_id: string;
  ref_path: string;
  title: string | null;
  snippet: string;
  rank: number;
  occurred_at: string;
}

const hits = (res: { body: { results: Hit[] } }): string[] =>
  res.body.results.map((r) => r.ref_path);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'search-'));
  await mkdir(join(root, 'notes'), { recursive: true });
  await mkdir(join(root, 'media'), { recursive: true });

  await writeFile(
    join(root, 'notes/fox.md'),
    '# Fox\n\nThe quick brown fox jumps over the lazy dog.\n' +
      'A brown fox is quick, and the brown fox is brown.\n',
  );
  await writeFile(join(root, 'notes/dog.md'), '# Dog\n\nA lazy dog sleeps all afternoon.\n');
  await writeFile(
    join(root, 'notes/imu.md'),
    '# IMU\n\nThe brooch carries an LSM6DSV16X on the AE-LSM6DSV16X breakout.\n',
  );
  await writeFile(
    join(root, 'notes/aside.md'),
    '# Aside\n\nSomething quick, mentioned once, about nothing in particular.\n',
  );
  await writeFile(join(root, 'media/diagram.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(
    join(root, 'notes/pasted.md'),
    '# Pasted\n\nSomething <script>alert(1)</script> peculiar was pasted in from the web,\n' +
      'where 2 < 3 and "quotes" survive.\n',
  );

  await truncateAll();
  await scanVault({ root, sourceId: await vaultSourceId() });

  // One discord message, so the source filter is tested against a view that
  // actually has two branches rather than one.
  await query(`INSERT INTO discord_guilds (id, name) VALUES ('1','G')`);
  await query(
    `INSERT INTO discord_channels (id, guild_id, name, type) VALUES ('10','1','general',0)`,
  );
  await query(
    `INSERT INTO discord_messages (id, channel_id, content, created_at)
     VALUES ('100','10','the quick brown fox was discussed here', now())`,
  );

  app = createApp({ vaultRoot: root });
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe('GET /api/search', () => {
  it('ranks the file containing the phrase most often first', async () => {
    const res = await request(app).get('/api/search').query({ q: 'brown fox' });
    expect(res.status).toBe(200);
    expect(res.body.results[0].ref_path).toBe('notes/fox.md');
    expect(res.body.total).toBeGreaterThan(0);
  });

  it('returns a highlighted snippet', async () => {
    const res = await request(app).get('/api/search').query({ q: 'brown fox' });
    expect(res.body.results[0].snippet).toContain('<b>');
    expect(res.body.results[0].snippet.toLowerCase()).toContain('fox');
  });

  it('honours quoted phrases', async () => {
    const res = await request(app).get('/api/search').query({ q: '"lazy dog"' });
    expect(hits(res).sort()).toEqual(['notes/dog.md', 'notes/fox.md']);

    const none = await request(app).get('/api/search').query({ q: '"dog lazy"' });
    expect(none.body.results).toHaveLength(0);
  });

  it('honours -exclusions', async () => {
    const res = await request(app).get('/api/search').query({ q: 'lazy -sleeps' });
    expect(hits(res)).toEqual(['notes/fox.md']);
  });

  it('finds a non-markdown file by FILENAME', async () => {
    const res = await request(app).get('/api/search').query({ q: 'diagram' });
    expect(res.body.results.some((r: Hit) => r.ref_path.endsWith('diagram.png'))).toBe(true);
  });

  it('ranks a filename-only match below every text match', async () => {
    await writeFile(join(root, 'media/quick.png'), Buffer.from([0x89, 0x50]));
    await scanVault({ root, sourceId: await vaultSourceId() });

    const res = await request(app).get('/api/search').query({ q: 'quick' });
    const paths = hits(res);
    expect(paths.at(-1)).toBe('media/quick.png');
    expect(paths.length).toBeGreaterThan(1);
  });

  it('finds a substring inside a longer word (part numbers)', async () => {
    // Full-text search indexes "LSM6DSV16X" as one token, so "LSM6DSV" never
    // matched. The keyword box must behave like an editor's find: any substring.
    const res = await request(app).get('/api/search').query({ q: 'LSM6DSV' });
    expect(res.status).toBe(200);
    expect(hits(res)).toEqual(['notes/imu.md']);
    expect(res.body.results[0].snippet).toContain('<b>LSM6DSV</b>16X');

    const suffix = await request(app).get('/api/search').query({ q: 'DSV16X' });
    expect(hits(suffix)).toEqual(['notes/imu.md']);

    const mixedCase = await request(app).get('/api/search').query({ q: 'lsm6dsv' });
    expect(hits(mixedCase)).toEqual(['notes/imu.md']);
  });

  it('ranks a substring-only match below full-text matches and above filename matches', async () => {
    await writeFile(join(root, 'notes/quicksand.md'), '# Sand\n\nQuicksand swallows the unwary.\n');
    await writeFile(join(root, 'media/quick.png'), Buffer.from([0x89, 0x50]));
    await scanVault({ root, sourceId: await vaultSourceId() });

    const res = await request(app).get('/api/search').query({ q: 'quick' });
    const paths = hits(res);
    expect(paths[0]).toBe('notes/fox.md');
    expect(paths.indexOf('notes/quicksand.md')).toBeGreaterThan(paths.indexOf('notes/aside.md'));
    expect(paths.at(-1)).toBe('media/quick.png');

    await rm(join(root, 'notes/quicksand.md'));
    await scanVault({ root, sourceId: await vaultSourceId() });
  });

  it('applies the source filter to substring matches', async () => {
    const res = await request(app).get('/api/search').query({ q: 'LSM6DSV', source: 'discord' });
    expect(res.body.results).toHaveLength(0);
  });

  it('matches the substring in the title, with a snippet from the content', async () => {
    const res = await request(app).get('/api/search').query({ q: 'IMU' });
    expect(hits(res)).toEqual(['notes/imu.md']);
  });

  it('filters by source', async () => {
    const all = await request(app).get('/api/search').query({ q: 'brown fox' });
    expect(all.body.results.some((r: Hit) => r.source_kind === 'discord')).toBe(true);

    const vaultOnly = await request(app).get('/api/search').query({ q: 'brown fox', source: 'vault' });
    expect(vaultOnly.body.results.every((r: Hit) => r.source_kind === 'vault')).toBe(true);
    expect(vaultOnly.body.results.length).toBeGreaterThan(0);
  });

  it('does not leak a filename hit into a discord-filtered search', async () => {
    const res = await request(app).get('/api/search').query({ q: 'diagram', source: 'discord' });
    expect(res.body.results).toHaveLength(0);
  });

  it('pages with a stable total', async () => {
    const page1 = await request(app).get('/api/search').query({ q: 'quick', limit: 1 });
    const page2 = await request(app).get('/api/search').query({ q: 'quick', limit: 1, offset: 1 });
    expect(page1.body.results).toHaveLength(1);
    expect(page1.body.total).toBe(page2.body.total);
    expect(page1.body.results[0].ref_path).not.toBe(page2.body.results[0].ref_path);
  });

  it('returns an empty result, not a 500, for gibberish', async () => {
    for (const q of ['zzzqqqxxnotaword', 'the', '!!!', 'a & b | c', "it's -- ok"]) {
      const res = await request(app).get('/api/search').query({ q });
      expect(res.status, q).toBe(200);
      expect(Array.isArray(res.body.results), q).toBe(true);
    }
  });

  it('treats LIKE metacharacters in the query as literal text', async () => {
    const res = await request(app).get('/api/search').query({ q: '%' });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });

  it('escapes HTML in the snippet, keeping only its own <b> markers', async () => {
    // ts_headline splices markers into raw file content without escaping it.
    // The frontend renders the snippet as HTML, so a note holding a <script>
    // tag would otherwise execute when it turned up in search results.
    const res = await request(app).get('/api/search').query({ q: 'peculiar' });
    const snippet = res.body.results[0].snippet as string;
    expect(snippet).toContain('<b>');
    expect(snippet).not.toContain('<script');
    // <b> is the only markup the snippet is allowed to carry.
    expect(snippet.replace(/<\/?b>/g, '')).not.toMatch(/[<>]/);

    const angle = await request(app).get('/api/search').query({ q: 'quotes' });
    const raw = angle.body.results[0].snippet as string;
    expect(raw).toContain('&quot;');
    expect(raw.replace(/<\/?b>/g, '')).not.toMatch(/[<>]/);
  });

  it('400s a missing or empty q', async () => {
    expect((await request(app).get('/api/search')).status).toBe(400);
    expect((await request(app).get('/api/search').query({ q: '   ' })).status).toBe(400);
  });
});
