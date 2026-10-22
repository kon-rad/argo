import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { HttpError, intParam, parseOr400, wrap } from './http.js';
import type { PostOptions, SocialProvider } from '../social/providers/types.js';
import { checkImageCount, MAX_ANY_BODY, MAX_IMAGES, toPostMedia } from '../social/media.js';
import { checkPost } from '../social/rules.js';
import {
  accountProvider,
  approvePost,
  cancelPost,
  disconnectAccount,
  listAccounts,
  listPosts,
  mediaByToken,
  queuePost,
  saveConnectedAccount,
} from '../social/store.js';

export interface SocialOptions {
  providers: Record<string, SocialProvider>;
  /** 64-char hex key for token encryption; routes 500 clearly if it's missing rather than storing plaintext. */
  tokenEncKey: string | undefined;
  /** e.g. https://brain.example.com — must match a redirect URI registered with each provider. */
  redirectBaseUrl: string;
  /** X's weighted length limit (280 free, 25,000 Premium). */
  xMaxChars: number;
}

/** The per-network settings a caller may set; rules.ts checks them against the account's network. */
export const PostOptionsSchema = z
  .object({
    instagramType: z.enum(['post', 'reel', 'story']),
    shareToFeed: z.boolean(),
    firstComment: z.string().max(2200),
    title: z.string().max(200),
    categoryId: z.string().regex(/^\d+$/),
    privacy: z.enum(['public', 'unlisted', 'private']),
    madeForKids: z.boolean(),
    notifySubscribers: z.boolean(),
    thread: z.array(z.string()).max(25),
    aiGenerated: z.boolean(),
  })
  .partial()
  .strict();

export const CARD_ID = /^t_[0-9a-f]{6,32}$/;
/** A vault-relative path: no leading slash, no `..`. */
export const SourcePath = z
  .string()
  .max(500)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'a vault-relative path');

const QueuePostBody =z.object({
  accountId: z.coerce.number().int().positive(),
  body: z.string().trim().min(1).max(MAX_ANY_BODY),
  /** Images in post order; the bytes travel as base64 (the JSON limit for this route is raised in app.ts). */
  media: z
    .array(z.object({ filename: z.string().min(1).max(200), altText: z.string(), dataBase64: z.string().min(1) }))
    .max(MAX_IMAGES)
    .default([]),
  scheduledFor: z.coerce.date(),
  options: PostOptionsSchema.default({}),
  /** A draft waits for POST /posts/:id/approve. */
  draft: z.boolean().default(false),
  /** The kanban card and the vault draft file behind the post (shown on the media schedule page). */
  cardId: z.string().regex(CARD_ID, 'a card id like t_0944bc6c').optional(),
  sourcePath: SourcePath.optional(),
});

const ListQuery = z.object({
  status: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Comma-separated account ids. */
  account_ids: z
    .string()
    .regex(/^\d+(,\d+)*$/, 'comma-separated account ids')
    .transform((s) => s.split(',').map(Number))
    .optional(),
});

const ApproveBody = z.object({ scheduledFor: z.coerce.date().optional() });

/** Serves one byte range when asked: video fetchers often read a file in pieces. */
function sendBytes(req: import('express').Request, res: import('express').Response, contentType: string, bytes: Buffer): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (m && (m[1] || m[2])) {
    const size = bytes.length;
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
      return;
    }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    res.end(bytes.subarray(start, end + 1));
    return;
  }
  res.setHeader('Content-Length', String(bytes.length));
  res.end(bytes);
}

/** In-memory OAuth state, a few minutes' TTL — this is a CSRF nonce, not data worth persisting across a restart. */
const pendingStates = new Map<string, { provider: string; expiresAt: number }>();
const STATE_TTL_MS = 10 * 60_000;

function newState(provider: string): string {
  const state = randomUUID();
  pendingStates.set(state, { provider, expiresAt: Date.now() + STATE_TTL_MS });
  return state;
}

function consumeState(state: string | undefined, provider: string): void {
  const entry = state ? pendingStates.get(state) : undefined;
  if (state) pendingStates.delete(state);
  if (!entry || entry.provider !== provider || entry.expiresAt < Date.now()) {
    throw new HttpError(400, 'invalid or expired OAuth state');
  }
}

function providerOrThrow(opts: SocialOptions, name: string): SocialProvider {
  const provider = opts.providers[name];
  if (!provider) throw new HttpError(404, `no such provider: ${name}`);
  return provider;
}

/**
 * The provider redirects the browser back here from its own site, and the
 * session cookie is SameSite=Strict, so this one route is mounted before the
 * session gate. The one-time state nonce stands in for the session: only a
 * logged-in /connect can mint one.
 */
export function socialCallbackRouter(opts: SocialOptions): Router {
  const router = Router();

  router.get(
    '/accounts/:provider/callback',
    wrap(async (req, res) => {
      const provider = providerOrThrow(opts, String(req.params.provider));
      consumeState(req.query.state as string | undefined, provider.id);
      const code = req.query.code as string | undefined;
      if (!code) throw new HttpError(400, 'missing authorization code');
      const redirectUri = `${opts.redirectBaseUrl}/api/social/accounts/${provider.id}/callback`;
      const connected = await provider.exchangeCode(code, redirectUri);
      const id = await saveConnectedAccount(provider.id, connected, opts.tokenEncKey);
      res.json({ connected: { id, displayName: connected.displayName } });
    }),
  );

  // A relay (Buffer) has no upload: it fetches each file from here while the
  // post is publishing. The token is the only key, so there is no session.
  const media = wrap(async (req, res) => {
    const token = String(req.params.token);
    const file = /^[A-Za-z0-9_-]{20,64}$/.test(token) ? await mediaByToken(token) : null;
    if (!file) throw new HttpError(404, 'not found');
    sendBytes(req, res, file.contentType, file.bytes);
  });
  router.get('/media/:token', media);
  router.get('/media/:token/:filename', media);

  return router;
}

export function socialRouter(opts: SocialOptions): Router {
  const router = Router();

  router.get(
    '/accounts',
    wrap(async (_req, res) => {
      res.json({ accounts: await listAccounts() });
    }),
  );

  router.get(
    '/accounts/:provider/connect',
    wrap(async (req, res) => {
      const provider = providerOrThrow(opts, String(req.params.provider));
      const state = newState(provider.id);
      const redirectUri = `${opts.redirectBaseUrl}/api/social/accounts/${provider.id}/callback`;
      res.redirect(provider.authUrl(state, redirectUri));
    }),
  );

  router.delete(
    '/accounts/:id',
    wrap(async (req, res) => {
      const id = intParam(req.params.id, 'account id');
      const ok = await disconnectAccount(id);
      if (!ok) throw new HttpError(404, 'no such connected account');
      res.json({ disconnected: true });
    }),
  );

  router.get(
    '/posts',
    wrap(async (req, res) => {
      const q = parseOr400(ListQuery, req.query);
      res.json({ posts: await listPosts({ status: q.status, from: q.from, to: q.to, accountIds: q.account_ids }) });
    }),
  );

  router.post(
    '/posts',
    wrap(async (req, res) => {
      const body = parseOr400(QueuePostBody, req.body);
      const account = await accountProvider(body.accountId);
      if (!account) throw new HttpError(404, 'no such connected account');
      checkImageCount(body.media.length);
      const media = body.media.map((m) => toPostMedia(m.filename, Buffer.from(m.dataBase64, 'base64'), m.altText));
      const options = body.options as PostOptions;
      checkPost(account.provider, body.body, media, options, { xMaxChars: opts.xMaxChars });
      const post = await queuePost(body.accountId, body.body, media, body.scheduledFor, options, body.draft ? 'draft' : 'queued', {
        cardId: body.cardId,
        sourcePath: body.sourcePath,
      });
      res.status(201).json({ post });
    }),
  );

  router.post(
    '/posts/:id/approve',
    wrap(async (req, res) => {
      const id = intParam(req.params.id, 'post id');
      const { scheduledFor } = parseOr400(ApproveBody, req.body ?? {});
      const post = await approvePost(id, new Date(), scheduledFor);
      if (!post) throw new HttpError(409, 'post is not a draft');
      res.json({ post });
    }),
  );

  router.delete(
    '/posts/:id',
    wrap(async (req, res) => {
      const id = intParam(req.params.id, 'post id');
      const ok = await cancelPost(id);
      if (!ok) throw new HttpError(409, 'post is not queued or a draft (already publishing, posted, or canceled)');
      res.json({ canceled: true });
    }),
  );

  return router;
}
