import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, dbStats, resetDbStats } from '../src/db.js';
import { scanVault } from '../src/connectors/vault/scan.js';
import { truncateAll, vaultSourceId } from './helpers.js';

let root: string;
let sourceId: number;

async function buildFixture(): Promise<void> {
  await mkdir(join(root, 'notes/sub'), { recursive: true });
  await mkdir(join(root, 'repo/node_modules'), { recursive: true });

  await writeFile(
    join(root, 'notes/alpha.md'),
    '---\ntitle: Alpha Note\ntags: [research]\n---\n\nLinks to [[beta]] and [[nowhere]].\n#inline\n',
  );
  await writeFile(join(root, 'notes/beta.md'), '# Beta\n\nThe quick brown fox jumps.\n');
  await writeFile(join(root, 'notes/sub/gamma.md'), '# Gamma\n\nnested note\n');
  await writeFile(join(root, 'diagram.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(root, 'repo/node_modules/junk.md'), '# junk');
  await writeFile(join(root, '.env'), 'ANTHROPIC_API_KEY=sk-live-do-not-index');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vaultscan-'));
  await buildFixture();
  sourceId = await vaultSourceId();
});

afterAll(() => rm(root, { recursive: true, force: true }));

beforeEach(truncateAll);

describe('scanVault', () => {
  it('inserts every file on a first scan', async () => {
    const stats = await scanVault({ root, sourceId });
    expect(stats.scanned).toBe(4);
    expect(stats.inserted).toBe(4);
    expect(stats.updated).toBe(0);
    expect(stats.unchanged).toBe(0);

    const { rows } = await query<{ count: number }>(`SELECT count(*)::int FROM vault_files`);
    expect(rows[0]!.count).toBe(4);
  });

  it('never indexes anything under a pruned directory', async () => {
    await scanVault({ root, sourceId });
    const { rows } = await query(`SELECT path FROM vault_files WHERE path LIKE '%node_modules%'`);
    expect(rows).toHaveLength(0);
  });

  it('never puts a credentials file in the index', async () => {
    // The index is /api/raw's allowlist, so a .env row here is a served .env.
    await scanVault({ root, sourceId });
    const { rows } = await query(`SELECT path FROM vault_files WHERE name LIKE '.env%'`);
    expect(rows).toHaveLength(0);
  });

  it('deletes a credentials file that an older scan had indexed', async () => {
    await query(
      `INSERT INTO vault_files (path, parent_path, name, ext, is_markdown, size_bytes, mtime, content_hash)
       VALUES ('.env', '', '.env', '', false, 10, now(), 'stale')`,
    );
    await scanVault({ root, sourceId });
    const { rows } = await query(`SELECT path FROM vault_files WHERE path = '.env'`);
    expect(rows).toHaveLength(0);
  });

  it('records what it pruned in the run stats', async () => {
    const stats = await scanVault({ root, sourceId });
    expect(stats.skippedDirs.map((d) => d.path)).toContain('repo/node_modules');
  });

  it('a re-scan with no changes issues ZERO writes to the vault tables', async () => {
    await scanVault({ root, sourceId });
    resetDbStats();
    const stats = await scanVault({ root, sourceId });

    expect(stats.unchanged).toBe(stats.scanned);
    expect(stats.inserted).toBe(0);
    expect(stats.updated).toBe(0);
    expect(stats.deleted).toBe(0);
    expect(dbStats.writesByTable['vault_files'] ?? 0).toBe(0);
    expect(dbStats.writesByTable['vault_links'] ?? 0).toBe(0);
    expect(dbStats.writesByTable['vault_tags'] ?? 0).toBe(0);
  });

  it('updates a changed file in place, preserving its row id', async () => {
    await scanVault({ root, sourceId });
    const before = await query<{ id: number; content_hash: string }>(
      `SELECT id, content_hash FROM vault_files WHERE path='notes/beta.md'`,
    );

    await writeFile(join(root, 'notes/beta.md'), '# Beta\n\nCompletely different words now.\n');
    const stats = await scanVault({ root, sourceId });
    expect(stats.updated).toBe(1);

    const after = await query<{ id: number; content_hash: string; body: string }>(
      `SELECT id, content_hash, body FROM vault_files WHERE path='notes/beta.md'`,
    );
    expect(after.rows[0]!.id).toBe(before.rows[0]!.id);
    expect(after.rows[0]!.content_hash).not.toBe(before.rows[0]!.content_hash);
    expect(after.rows[0]!.body).toContain('Completely different');

    await writeFile(join(root, 'notes/beta.md'), '# Beta\n\nThe quick brown fox jumps.\n');
  });

  it('removes a deleted file and cascades its links and tags', async () => {
    await scanVault({ root, sourceId });
    const { rows } = await query<{ id: number }>(
      `SELECT id FROM vault_files WHERE path='notes/alpha.md'`,
    );
    const alphaId = rows[0]!.id;
    expect((await query(`SELECT 1 FROM vault_tags WHERE file_id=$1`, [alphaId])).rows.length)
      .toBeGreaterThan(0);

    await unlink(join(root, 'notes/alpha.md'));
    const stats = await scanVault({ root, sourceId });
    expect(stats.deleted).toBe(1);

    expect((await query(`SELECT 1 FROM vault_files WHERE id=$1`, [alphaId])).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM vault_links WHERE from_file_id=$1`, [alphaId])).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM vault_tags WHERE file_id=$1`, [alphaId])).rows).toHaveLength(0);

    await writeFile(
      join(root, 'notes/alpha.md'),
      '---\ntitle: Alpha Note\ntags: [research]\n---\n\nLinks to [[beta]] and [[nowhere]].\n#inline\n',
    );
  });

  it('indexes non-markdown files as metadata only, with a null body', async () => {
    await scanVault({ root, sourceId });
    const { rows } = await query<{ is_markdown: boolean; body: string | null; size_bytes: number }>(
      `SELECT is_markdown, body, size_bytes FROM vault_files WHERE path='diagram.png'`,
    );
    expect(rows[0]!.is_markdown).toBe(false);
    expect(rows[0]!.body).toBeNull();
    expect(rows[0]!.size_bytes).toBe(4);
  });

  it('stores frontmatter, tags and links for markdown', async () => {
    await scanVault({ root, sourceId });
    const { rows } = await query<{ id: number; title: string; frontmatter: Record<string, unknown> }>(
      `SELECT id, title, frontmatter FROM vault_files WHERE path='notes/alpha.md'`,
    );
    expect(rows[0]!.title).toBe('Alpha Note');
    expect(rows[0]!.frontmatter).toMatchObject({ title: 'Alpha Note' });

    const tags = await query<{ tag: string }>(`SELECT tag FROM vault_tags WHERE file_id=$1 ORDER BY tag`, [rows[0]!.id]);
    expect(tags.rows.map((r) => r.tag)).toEqual(['inline', 'research']);

    const links = await query<{ target_raw: string }>(
      `SELECT target_raw FROM vault_links WHERE from_file_id=$1 ORDER BY target_raw`,
      [rows[0]!.id],
    );
    expect(links.rows.map((r) => r.target_raw)).toEqual(['beta', 'nowhere']);
  });

  it('writes a completed ingest_runs row with stats', async () => {
    const stats = await scanVault({ root, sourceId });
    const { rows } = await query<{ status: string; stats: Record<string, unknown>; finished_at: string }>(
      `SELECT status, stats, finished_at FROM ingest_runs ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.status).toBe('ok');
    expect(rows[0]!.finished_at).not.toBeNull();
    expect(rows[0]!.stats).toMatchObject({ scanned: stats.scanned });
  });
});
