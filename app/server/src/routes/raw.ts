import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Router } from 'express';
import { log } from '../logger.js';
import { HttpError, wrap } from './http.js';
import { contentTypeFor } from './mime.js';
import { resolveIndexed } from './vaultPath.js';

interface Range {
  start: number;
  end: number;
}

/** Single-range only. Multipart ranges buy nothing for a local media player. */
export function parseRange(header: string | undefined, size: number): Range | null | 'unsatisfiable' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;

  const [, rawStart, rawEnd] = m;
  let start: number;
  let end: number;

  if (rawStart === '') {
    if (rawEnd === '') return 'unsatisfiable';
    const suffix = Number(rawEnd);
    if (suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

/** encodeURIComponent leaves ' ( ) * alone, and ' is the RFC 5987 delimiter. */
export const rfc5987 = (s: string): string =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function rawRouter(vaultRoot: string): Router {
  const router = Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const { abs, row } = await resolveIndexed(vaultRoot, req.query['path']);

      // The index can lag the disk by one scan; a file deleted since then is
      // gone, not a server error.
      const info = await stat(abs).catch(() => null);
      if (!info || !info.isFile()) throw new HttpError(404, `no longer on disk: ${row.path}`);

      const type = contentTypeFor(row.ext);
      res.setHeader('Content-Type', type);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-cache');
      // Never let the browser run vault HTML or SVG as a same-origin document.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      if (req.query['download'] === '1') {
        // RFC 6266/5987: the ASCII fallback for old clients, the UTF-8 form for
        // everyone else — vault names carry em dashes and accents.
        const ascii = row.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(row.name)}`,
        );
      }

      const range = parseRange(req.headers.range, info.size);
      if (range === 'unsatisfiable') {
        res.setHeader('Content-Range', `bytes */${info.size}`);
        throw new HttpError(416, 'range not satisfiable');
      }

      if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
        res.setHeader('Content-Length', String(range.end - range.start + 1));
      } else {
        res.setHeader('Content-Length', String(info.size));
      }

      const stream = createReadStream(abs, range ? { start: range.start, end: range.end } : {});
      stream.on('error', (err) => {
        log.error(`raw stream failed for ${row.path}:`, err);
        res.destroy();
      });
      stream.pipe(res);
      await new Promise<void>((resolve) => {
        stream.on('close', () => resolve());
      });
    }),
  );

  return router;
}
