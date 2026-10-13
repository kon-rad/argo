import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Router } from 'express';
import { assertIndexed, safeVaultPath } from '../paths.js';
import { log } from '../logger.js';
import { HttpError, wrap } from './http.js';
import { rfc5987 } from './raw.js';
import { resolveIndexed } from './vaultPath.js';

export interface B2Options {
  /**
   * `b2store serve 127.0.0.1:5124 vault` on the same box: a read-only HTTP view
   * of the bucket's `vault/` prefix. Unset on the Mac, where the originals are
   * still on disk and the stub just points at its sibling.
   */
  serveUrl?: string;
}

const STUB_EXT = '.b2.md';
/** Headers a media player needs to seek; everything else from rclone stays behind. */
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

/** `vault/Areas/x/clip.mp4` -> `Areas/x/clip.mp4`, or null if it is anything else. */
export function stubTarget(b2Path: unknown): string | null {
  if (typeof b2Path !== 'string' || !b2Path.startsWith('vault/')) return null;
  const rest = b2Path.slice('vault/'.length);
  const parts = rest.split('/');
  if (rest === '' || parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return rest;
}

/**
 * Streams the file a `.b2.md` stub stands in for. The only way in is through
 * an indexed stub, so a logged-in browser can reach exactly the objects the
 * vault references, never an arbitrary bucket path.
 */
export function b2Router(vaultRoot: string, opts: B2Options): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const { row } = await resolveIndexed(vaultRoot, req.query['path']);
      const target = stubTarget(row.frontmatter?.['b2_path']);
      if (!target) throw new HttpError(404, `not a B2 stub: ${row.path}`);
      const download = req.query['download'] === '1';

      // The Mac still has the original next to its stub: serve that, no B2 round trip.
      if (row.path.endsWith(STUB_EXT)) {
        const sibling = row.path.slice(0, -STUB_EXT.length);
        const abs = safeVaultPath(vaultRoot, sibling);
        const onDisk = abs && (await stat(abs).catch(() => null))?.isFile();
        if (onDisk && (await assertIndexed(sibling))) {
          const qs = new URLSearchParams({ path: sibling, ...(download ? { download: '1' } : {}) });
          res.redirect(302, `/api/raw?${qs}`);
          return;
        }
      }

      if (!opts.serveUrl) throw new HttpError(503, 'B2 streaming is not configured on this server (B2_SERVE_URL)');

      const upstreamUrl = `${opts.serveUrl.replace(/\/+$/, '')}/${target.split('/').map(encodeURIComponent).join('/')}`;
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const range = req.headers.range;
      const upstream = await fetch(upstreamUrl, {
        headers: range ? { range } : {},
        signal: abort.signal,
      }).catch((err: unknown) => {
        log.error('b2 serve unreachable:', err);
        throw new HttpError(502, 'B2 storage is unreachable');
      });

      if (upstream.status === 404) throw new HttpError(404, `not in B2: ${row.frontmatter?.['b2_path']}`);
      if (upstream.status === 416) {
        const cr = upstream.headers.get('content-range');
        if (cr) res.setHeader('Content-Range', cr);
        throw new HttpError(416, 'range not satisfiable');
      }
      if (!upstream.ok || !upstream.body) throw new HttpError(502, `B2 storage answered ${upstream.status}`);

      res.status(upstream.status);
      for (const h of PASS_HEADERS) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      if (download) {
        const name = target.split('/').pop()!;
        const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(name)}`);
      }

      const body = Readable.fromWeb(upstream.body as unknown as WebReadableStream);
      body.on('error', (err) => {
        if (!abort.signal.aborted) log.error(`b2 stream failed for ${target}:`, err);
        res.destroy();
      });
      body.pipe(res);
      await new Promise<void>((resolve) => {
        res.on('close', () => resolve());
      });
    }),
  );

  return router;
}
