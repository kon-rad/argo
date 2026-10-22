import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { loadBrand, loadBrands, safeVaultPath } from '../src/media-schedule.js';
import { listPosts, queuePost } from '../src/social/store.js';
import { truncateAll } from './helpers.js';

const BRAND = `---
brand: argo
name: Argo
updated: 2026-10-21
tracker_projects: [argo-reel]
style_guides:
  - media/style/long-form.md
channels:
  - id: instagram
    network: instagram
    handle: "@argo"
    url: https://www.instagram.com/argo/
    posting: buffer
    account_id: ACC1
    style_guide: media/style/reel.md
  - id: linkedin
    network: linkedin
    posting: direct
    account_id: ACC2
    url: unknown
    role: personal profile
    on_website: false
    style_guide: media/style/missing.md
  - id: blog
    network: web
    url: https://example.com/blog
    posting: manual
    files: media/blog/
---
Prose for people.
`;

function vaultWith(brand: string, extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sb-media-'));
  mkdirSync(join(root, 'media', 'style'), { recursive: true });
  writeFileSync(join(root, 'media', 'style', 'long-form.md'), '# long form\n');
  writeFileSync(join(root, 'media', 'style', 'reel.md'), '# reel\n');
  writeFileSync(join(root, 'media', 'media-brand.md'), brand);
  for (const [name, text] of Object.entries(extra)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  writeFileSync(join(root, 'secondbrain.json'), JSON.stringify({ media: { brands: [{ slug: 'argo', config: 'media/media-brand.md' }] } }));
  return root;
}

const IDS = new Set([1, 2, 3]);
const withIds = (a: number, b: number) => BRAND.replace('ACC1', String(a)).replace('ACC2', String(b));

describe('brand config', () => {
  it('parses channels, flags a missing style guide and an unconfirmed profile, and keeps going', () => {
    const root = vaultWith(withIds(1, 2));
    const r = loadBrand(root, 'argo', 'media/media-brand.md', IDS, new Map());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channels.map((c) => c.id)).toEqual(['instagram', 'linkedin', 'blog']);
    expect(r.channels[1]).toMatchObject({ url: null, urlUnconfirmed: true, styleGuideMissing: true, role: 'personal profile' });
    expect(r.channels[0]).toMatchObject({ url: 'https://www.instagram.com/argo/', styleGuideMissing: false });
    expect(r.warnings).toEqual([
      'style guide not found: media/style/missing.md (channel linkedin)',
      'channel linkedin: profile not confirmed yet',
    ]);
    expect(r.trackerProjects).toEqual(['argo-reel']);
  });

  it('reports a file that will not parse with its line, and a file that is missing', () => {
    const broken = vaultWith('---\nbrand: argo\nchannels: [unclosed\n---\n');
    const r = loadBrand(broken, 'argo', 'media/media-brand.md', IDS, new Map());
    expect(r).toMatchObject({ ok: false, error: { file: 'media/media-brand.md' } });
    if (!r.ok) expect(r.error.line).toBeGreaterThan(0);
    expect(loadBrand(broken, 'argo', 'media/none.md', IDS, new Map())).toMatchObject({ ok: false, error: { message: expect.stringContaining('does not exist') } });
    expect(loadBrand(broken, 'argo', '../outside.md', IDS, new Map())).toMatchObject({ ok: false, error: { message: expect.stringContaining('inside the vault') } });
  });

  it('refuses the rules the page depends on', () => {
    const root = vaultWith(withIds(1, 2));
    const one = (patch: (s: string) => string) => loadBrand(vaultWith(patch(withIds(1, 2))), 'argo', 'media/media-brand.md', IDS, new Map());
    expect(one((s) => s.replace('account_id: 2', 'account_id: 1'))).toMatchObject({ ok: false, error: { message: expect.stringContaining('already used by another channel') } });
    expect(one((s) => s.replace('account_id: 2', 'account_id: 99'))).toMatchObject({ ok: false, error: { message: expect.stringContaining('not a connected account') } });
    expect(one((s) => s.replace('    posting: manual', '    posting: manual\n    account_id: 3'))).toMatchObject({ ok: false, error: { message: expect.stringContaining('manual but has an account_id') } });
    expect(one((s) => s.replace('    posting: direct\n    account_id: 2', '    posting: direct'))).toMatchObject({ ok: false, error: { message: expect.stringContaining('needs an account_id') } });
    expect(one((s) => s.replace('brand: argo', 'brand: other'))).toMatchObject({ ok: false, error: { message: expect.stringContaining('brand "other"') } });
    // An account taken by an earlier brand cannot be reused by a later one.
    const claimed = new Map<number, string>([[1, 'konrad']]);
    expect(loadBrand(root, 'argo', 'media/media-brand.md', IDS, claimed)).toMatchObject({ ok: false, error: { message: expect.stringContaining('brand "konrad"') } });
  });

  it('keeps paths inside the vault', () => {
    expect(safeVaultPath('a/b.md')).toBe('a/b.md');
    expect(safeVaultPath('../x')).toBeNull();
    expect(safeVaultPath('/etc/passwd')).toBeNull();
  });
});

describe('calendar and API', () => {
  beforeEach(truncateAll);

  async function account(provider: string, transport: 'buffer' | 'direct', disconnected = false): Promise<number> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO social_accounts (provider, provider_account_id, display_name, access_token, access_token_expires_at, transport, disconnected_at)
       VALUES ($1, $2, $3, 'placeholder', now() + interval '10 days', $4, ${disconnected ? 'now()' : 'NULL'}) RETURNING id`,
      [provider, `${provider}-${transport}`, provider, transport],
    );
    return Number(rows[0]!.id);
  }

  async function seed() {
    const ig = await account('instagram', 'buffer');
    const li = await account('linkedin', 'direct');
    const vault = vaultWith(withIds(ig, li));
    const at = (d: string) => new Date(`2026-10-${d}T09:00:00Z`);
    const a = await queuePost(ig, 'reel one', [], at('21'), {}, 'queued', { cardId: 't_0944bc6c', sourcePath: 'media/social-posts/one.md' });
    await queuePost(ig, 'reel two', [], at('22'), {}, 'draft');
    await queuePost(li, 'li post', [], at('21'), {}, 'queued');
    await queuePost(li, 'canceled post', [], at('21'), {}, 'draft').then((p) => query(`UPDATE social_posts SET status = 'canceled' WHERE id = $1`, [p.id]));
    await queuePost(ig, 'next month', [], new Date('2026-11-20T09:00:00Z'), {}, 'queued');
    return { ig, li, vault, a };
  }

  it('lists a brand with account health, and an error card per broken brand', async () => {
    const { vault } = await seed();
    const [b] = await loadBrands(vault);
    expect(b!.ok).toBe(true);
    if (!b!.ok) return;
    expect(b.channels[0]!.account).toMatchObject({ state: 'connected', provider: 'instagram', tokenExpiresInDays: null });
    expect(b.channels[1]!.account).toMatchObject({ state: 'connected', tokenExpiresInDays: 9 });
    expect(b.channels[2]!.account).toBeNull();
  });

  it('returns each post under its channel with the card and draft file, counts for the range, and honours the range', async () => {
    const { vault, a } = await seed();
    const app = createApp({ modules: new Set(['social']), vaultRoot: vault, social: { providers: {}, tokenEncKey: undefined, redirectBaseUrl: 'http://x', xMaxChars: 280 } });
    const res = await request(app).get('/api/media/brands/argo/calendar?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z').expect(200);
    const posts = res.body.posts as { id: number; channelId: string; status: string; card_id: string | null; source_path: string | null }[];
    expect(posts.map((p) => [p.channelId, p.status])).toEqual([['instagram', 'queued'], ['linkedin', 'queued'], ['linkedin', 'canceled'], ['instagram', 'draft']]);
    expect(posts.find((p) => p.id === a.id)).toMatchObject({ card_id: 't_0944bc6c', source_path: 'media/social-posts/one.md' });
    const counts = Object.fromEntries((res.body.channels as { id: string; counts: unknown }[]).map((c) => [c.id, c.counts]));
    expect(counts.instagram).toEqual({ draft: 1, queued: 1, posted: 0, failed: 0 });
    expect(counts.linkedin).toEqual({ draft: 0, queued: 1, posted: 0, failed: 0 });
    await request(app).get('/api/media/brands/argo/calendar?from=2026-10-01T00:00:00Z&to=2026-09-01T00:00:00Z').expect(400);
    await request(app).get('/api/media/brands/argo/calendar?from=2026-01-01T00:00:00Z&to=2026-12-01T00:00:00Z').expect(400);
    await request(app).get('/api/media/brands/nope/calendar?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z').expect(404);
    const all = await request(app).get('/api/media/brands').expect(200);
    expect(all.body.brands[0]).toMatchObject({ ok: true, slug: 'argo', name: 'Argo' });
  });

  it('answers 422 naming the file when the brand file is broken; the page keeps the other brands', async () => {
    const vault = vaultWith('---\nbrand: argo\nname: [\n---\n');
    const app = createApp({ modules: new Set(['social']), vaultRoot: vault, social: { providers: {}, tokenEncKey: undefined, redirectBaseUrl: 'http://x', xMaxChars: 280 } });
    const res = await request(app).get('/api/media/brands/argo/calendar?from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z').expect(422);
    expect(res.body.error.file).toBe('media/media-brand.md');
    expect((await request(app).get('/api/media/brands').expect(200)).body.brands[0]).toMatchObject({ ok: false });
  });

  it('is not mounted without the social module', async () => {
    const vault = vaultWith(withIds(1, 2));
    await request(createApp({ modules: new Set(['projects']), vaultRoot: vault })).get('/api/media/brands').expect(404);
  });

  it('filters the post list by range and accounts, and takes card and draft file on queue', async () => {
    const { ig, li, vault } = await seed();
    expect((await listPosts({ accountIds: [li] })).map((p) => p.body)).toEqual(['li post', 'canceled post']);
    expect((await listPosts({ from: new Date('2026-10-22T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z') })).map((p) => p.body)).toEqual(['reel two']);
    const app = createApp({ modules: new Set(['social']), vaultRoot: vault, social: { providers: {}, tokenEncKey: undefined, redirectBaseUrl: 'http://x', xMaxChars: 280 } });
    const q = await request(app).get(`/api/social/posts?account_ids=${ig}&from=2026-10-21T00:00:00Z&to=2026-10-22T00:00:00Z`).expect(200);
    expect(q.body.posts.map((p: { body: string }) => p.body)).toEqual(['reel one']);
    await request(app).get('/api/social/posts?account_ids=a,b').expect(400);
    await request(app).post('/api/social/posts').send({ accountId: ig, body: 'x', scheduledFor: '2026-10-25T09:00:00Z', cardId: 'nope' }).expect(400);
    await request(app).post('/api/social/posts').send({ accountId: ig, body: 'x', scheduledFor: '2026-10-25T09:00:00Z', sourcePath: '../secret' }).expect(400);
    const ok = await request(app).post('/api/social/posts').send({ accountId: li, body: 'x', scheduledFor: '2026-10-25T09:00:00Z', draft: true, cardId: 't_abcdef12', sourcePath: 'a/b.md' });
    expect(ok.status).toBe(201);
    expect(ok.body.post).toMatchObject({ card_id: 't_abcdef12', source_path: 'a/b.md' });
  });
});
