import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { settings } from '../settings.js';
import { HttpError, parseOr400, wrap } from './http.js';
import {
  cleanDestDir,
  cleanFilename,
  inboxKey,
  partCountFor,
  partSizeFor,
  suggestDestination,
  UploadInputError,
} from '../uploads/paths.js';
import { getUpload, type UploadRow, type UploadsDeps } from '../uploads/service.js';

export interface UploadsRouterOptions extends UploadsDeps {
  /** Largest single file, in bytes. */
  maxBytes: number;
  /** Called when a finished upload is ready to move into the vault. */
  onUploaded: () => void;
}

const PRESIGN_SECONDS = 6 * 3600;
const MAX_PRESIGN_BATCH = 50;

const Create = z.object({
  filename: z.string().min(1).max(1000),
  size: z.number().int().positive(),
  contentType: z.string().max(200).optional(),
  destDir: z.string().min(1).max(1000),
  description: z.string().max(4000).default(''),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  toM1: z.boolean().default(false),
});

const Parts = z.object({ partNumbers: z.array(z.number().int().positive()).min(1).max(MAX_PRESIGN_BATCH) });

function publicRow(r: UploadRow): Record<string, unknown> {
  const { s3_upload_id: _omit, ...rest } = r;
  return { ...rest, size_bytes: Number(r.size_bytes) };
}

function bad(err: unknown): never {
  if (err instanceof UploadInputError) throw new HttpError(400, err.message);
  throw err;
}

export function uploadsRouter(opts: UploadsRouterOptions): Router {
  const router = Router();
  const { store } = opts;

  async function load(idRaw: string | string[] | undefined): Promise<UploadRow> {
    const id = typeof idRaw === 'string' ? idRaw : '';
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, 'no such upload');
    const row = await getUpload(id);
    if (!row) throw new HttpError(404, 'no such upload');
    return row;
  }

  router.get('/config', (_req, res) => {
    const cfg = settings().uploads;
    res.json({ destinations: cfg.destinations, maxBytes: opts.maxBytes });
  });

  // Suggests a preset folder for a file name and description, so the form can pre-select it.
  router.get('/suggest', (req, res) => {
    const text = `${typeof req.query['q'] === 'string' ? req.query['q'] : ''}`;
    const hit = suggestDestination(settings().uploads.destinations, text);
    res.json({ destination: hit ?? null });
  });

  router.get(
    '/',
    wrap(async (_req, res) => {
      const { rows } = await query<UploadRow>(`SELECT * FROM uploads ORDER BY created_at DESC LIMIT 100`);
      res.json({ uploads: rows.map(publicRow) });
    }),
  );

  router.post(
    '/',
    wrap(async (req, res) => {
      const body = parseOr400(Create, req.body);
      if (body.size > opts.maxBytes) {
        throw new HttpError(413, `file is larger than the ${Math.floor(opts.maxBytes / 1024 ** 3)} GB limit`);
      }
      let filename: string;
      let destDir: string;
      try {
        filename = cleanFilename(body.filename);
        destDir = cleanDestDir(body.destDir);
      } catch (err) {
        bad(err);
      }
      const id = randomUUID();
      const key = inboxKey(id, filename);
      const partSize = partSizeFor(body.size);
      const s3UploadId = await store.createMultipart(key, body.contentType);
      const { rows } = await query<UploadRow>(
        `INSERT INTO uploads (id, filename, size_bytes, content_type, dest_dir, description, tags, part_size, s3_upload_id, inbox_key, to_m1)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [id, filename, body.size, body.contentType ?? null, destDir, body.description.trim(), body.tags, partSize, s3UploadId, key, body.toM1],
      );
      res.status(201).json({ upload: publicRow(rows[0]!), partSize, partCount: partCountFor(body.size, partSize) });
    }),
  );

  // Status, plus the parts B2 already holds, which is what a resumed upload skips.
  router.get(
    '/:id',
    wrap(async (req, res) => {
      const row = await load(req.params['id']);
      const parts = row.status === 'uploading' && row.s3_upload_id ? await store.listParts(row.inbox_key, row.s3_upload_id) : [];
      res.json({
        upload: publicRow(row),
        partSize: row.part_size,
        partCount: partCountFor(Number(row.size_bytes), row.part_size),
        donePartNumbers: parts.map((p) => p.partNumber),
      });
    }),
  );

  router.post(
    '/:id/parts',
    wrap(async (req, res) => {
      const row = await load(req.params['id']);
      if (row.status !== 'uploading' || !row.s3_upload_id) throw new HttpError(409, `upload is ${row.status}`);
      const { partNumbers } = parseOr400(Parts, req.body);
      const count = partCountFor(Number(row.size_bytes), row.part_size);
      if (partNumbers.some((n) => n > count)) throw new HttpError(400, `this upload has ${count} parts`);
      const urls: Record<string, string> = {};
      for (const n of partNumbers) urls[String(n)] = await store.presignPart(row.inbox_key, row.s3_upload_id, n, PRESIGN_SECONDS);
      await query(`UPDATE uploads SET updated_at = now() WHERE id = $1`, [row.id]);
      res.json({ urls });
    }),
  );

  // The server lists the parts itself rather than trusting the browser's ETags, and checks every size.
  router.post(
    '/:id/complete',
    wrap(async (req, res) => {
      const row = await load(req.params['id']);
      if (row.status === 'uploaded' || row.status === 'ingesting' || row.status === 'stored') {
        res.json({ upload: publicRow(row) });
        return;
      }
      if (row.status !== 'uploading' || !row.s3_upload_id) throw new HttpError(409, `upload is ${row.status}`);
      const size = Number(row.size_bytes);
      const count = partCountFor(size, row.part_size);
      const have = new Map((await store.listParts(row.inbox_key, row.s3_upload_id)).map((p) => [p.partNumber, p]));
      const missing: number[] = [];
      const wrong: number[] = [];
      for (let n = 1; n <= count; n++) {
        const p = have.get(n);
        const expected = n < count ? row.part_size : size - row.part_size * (count - 1);
        if (!p) missing.push(n);
        else if (p.size !== expected) wrong.push(n);
      }
      if (missing.length || wrong.length) {
        throw new HttpError(409, 'parts are missing or the wrong size', { missing: missing.slice(0, 100), wrong: wrong.slice(0, 100) });
      }
      await store.complete(row.inbox_key, row.s3_upload_id, [...have.values()].sort((a, b) => a.partNumber - b.partNumber));
      const { rows } = await query<UploadRow>(
        `UPDATE uploads SET status = 'uploaded', updated_at = now() WHERE id = $1 RETURNING *`,
        [row.id],
      );
      opts.onUploaded();
      res.json({ upload: publicRow(rows[0]!) });
    }),
  );

  router.post(
    '/:id/abort',
    wrap(async (req, res) => {
      const row = await load(req.params['id']);
      if (row.status !== 'uploading') throw new HttpError(409, `upload is ${row.status}`);
      if (row.s3_upload_id) await store.abort(row.inbox_key, row.s3_upload_id);
      const { rows } = await query<UploadRow>(
        `UPDATE uploads SET status = 'aborted', updated_at = now() WHERE id = $1 RETURNING *`,
        [row.id],
      );
      res.json({ upload: publicRow(rows[0]!) });
    }),
  );

  // A failed move into the vault: the inbox copy is still there, so try again.
  router.post(
    '/:id/retry',
    wrap(async (req, res) => {
      const row = await load(req.params['id']);
      if (row.status !== 'failed') throw new HttpError(409, `upload is ${row.status}`);
      const { rows } = await query<UploadRow>(
        `UPDATE uploads SET status = 'uploaded', error = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
        [row.id],
      );
      opts.onUploaded();
      res.json({ upload: publicRow(rows[0]!) });
    }),
  );

  // Ask for a working copy on the second machine (before or after the file is stored).
  router.post(
    '/:id/m1',
    wrap(async (req, res) => {
      const row = await load(req.params['id']);
      if (row.status === 'aborted' || row.status === 'failed') throw new HttpError(409, `upload is ${row.status}`);
      const { rows } = await query<UploadRow>(
        `UPDATE uploads SET to_m1 = true,
                m1_status = CASE WHEN status = 'stored' AND (m1_status IS NULL OR m1_status = 'failed') THEN 'pending' ELSE m1_status END,
                m1_error = NULL, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [row.id],
      );
      res.json({ upload: publicRow(rows[0]!) });
    }),
  );

  return router;
}
