import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import { assertIndexed } from '../paths.js';
import { settings } from '../settings.js';
import { HttpError, wrap } from './http.js';
import { parseRange } from './raw.js';

/**
 * The tv module: rendered video episodes kept in the vault, one folder each
 * under the `tv.episodesDir` of secondbrain.json (default `tv/episodes`).
 * Each has an `episode.md` whose frontmatter the page lists, and an
 * `episode.mp4` that is usually gitignored. A machine with the MP4 on disk
 * serves it from `/media/<id>` here (big media is never in the index); a
 * server without it streams it from B2 through the indexed `.b2.md` stub via
 * /api/b2. `video` is null when neither is reachable, and the episode is
 * listed as not playable.
 */

/** The vault-relative episodes folder; a setting that climbs out of the vault falls back to the default. */
export function episodesDir(vaultRoot: string): string {
  const dir = settings(vaultRoot).tv.episodesDir.replace(/^\/+|\/+$/g, '');
  return dir && !dir.split('/').includes('..') ? dir : 'tv/episodes';
}
/** Episode folders are `YYYY-MM-DD_slug`; anything else is not an id, so no path can escape the folder. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;

export interface Episode {
  id: string;
  title: string;
  show: string;
  generated_at: string | null;
  duration_s: number | null;
  voice: string | null;
  note: string;
  /** A same-origin URL the <video> tag can play, or null. */
  video: string | null;
  /** Where `video` comes from, for the page's label. */
  source: 'local' | 'b2' | null;
}

/** The flat `key: value` frontmatter publish.py writes; no nested YAML. */
export function parseFlatFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

const num = (s: string | undefined): number | null => (s && Number.isFinite(Number(s)) ? Number(s) : null);

/** Which URL can play this episode right now: the file on this disk, else the indexed B2 stub. */
export async function resolveVideo(vaultRoot: string, id: string): Promise<Pick<Episode, 'video' | 'source'>> {
  if (!ID.test(id)) return { video: null, source: null };
  const mp4 = `${episodesDir(vaultRoot)}/${id}/episode.mp4`;
  const stub = `${mp4}.b2.md`;
  const onDisk = (await stat(join(vaultRoot, mp4)).catch(() => null))?.isFile() ?? false;
  if (onDisk) return { video: `/api/tv/media/${encodeURIComponent(id)}`, source: 'local' };
  if (await assertIndexed(stub)) return { video: `/api/b2?path=${encodeURIComponent(stub)}`, source: 'b2' };
  return { video: null, source: null };
}

export async function listEpisodes(vaultRoot: string): Promise<Episode[]> {
  const base = episodesDir(vaultRoot);
  const dir = join(vaultRoot, base);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const episodes: Episode[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const note = `${base}/${entry.name}/episode.md`;
    const text = await readFile(join(vaultRoot, note), 'utf8').catch(() => null);
    if (text === null) continue;
    const fm = parseFlatFrontmatter(text);
    const { video, source } = await resolveVideo(vaultRoot, entry.name);
    episodes.push({
      id: entry.name,
      title: fm['title'] || entry.name,
      show: fm['show'] || 'news',
      generated_at: fm['generated_at'] || null,
      duration_s: num(fm['duration_s']),
      voice: fm['voice'] || null,
      note,
      video,
      source,
    });
  }
  return episodes.sort((a, b) => (b.generated_at ?? b.id).localeCompare(a.generated_at ?? a.id));
}

export function tvRouter(vaultRoot: string): Router {
  const router = Router();
  router.get(
    '/episodes',
    wrap(async (_req, res) => {
      const { shows } = settings(vaultRoot).tv;
      res.json({ episodes: await listEpisodes(vaultRoot), shows, episodesDir: episodesDir(vaultRoot) });
    }),
  );

  // The one file a player may read from disk: <episodes>/<id>/episode.mp4, with
  // byte ranges so the <video> tag can seek. Same range handling as /api/raw.
  router.get(
    '/media/:id',
    wrap(async (req, res) => {
      const id = String(req.params['id'] ?? '');
      if (!ID.test(id)) throw new HttpError(400, 'not an episode id');
      const abs = join(vaultRoot, episodesDir(vaultRoot), id, 'episode.mp4');
      const info = await stat(abs).catch(() => null);
      if (!info || !info.isFile()) throw new HttpError(404, `no episode video on this machine: ${id}`);

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const range = parseRange(req.headers.range, info.size);
      if (range === 'unsatisfiable') {
        res.setHeader('Content-Range', `bytes */${info.size}`);
        throw new HttpError(416, 'range not satisfiable');
      }
      if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
        res.setHeader('Content-Length', String(range.end - range.start + 1));
        createReadStream(abs, { start: range.start, end: range.end }).pipe(res);
      } else {
        res.setHeader('Content-Length', String(info.size));
        createReadStream(abs).pipe(res);
      }
      await new Promise<void>((resolve) => {
        res.on('close', () => resolve());
      });
    }),
  );
  return router;
}
