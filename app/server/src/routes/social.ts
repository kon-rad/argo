import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { HttpError, intParam, parseOr400, wrap } from './http.js';
import type { SocialProvider } from '../social/providers/types.js';
import { checkImageCount, MAX_IMAGES, toPostMedia } from '../social/media.js';
import { cancelPost, disconnectAccount, listAccounts, listPosts, queuePost, saveConnectedAccount } from '../social/store.js';

export interface SocialOptions {
  providers: Record<string, SocialProvider>;
  /** 64-char hex key for token encryption; routes 500 clearly if it's missing rather than storing plaintext. */
  tokenEncKey: string | undefined;
  /** e.g. https://brain.example.com — must match a redirect URI registered with each provider. */
  redirectBaseUrl: string;
}

const QueuePostBody = z.object({
  accountId: z.coerce.number().int().positive(),
  body: z.string().trim().min(1).max(3000),
  /** Images in post order; the bytes travel as base64 (the JSON limit for this route is raised in app.ts). */
  media: z
    .array(z.object({ filename: z.string().min(1).max(200), altText: z.string(), dataBase64: z.string().min(1) }))
    .max(MAX_IMAGES)
    .default([]),
  scheduledFor: z.coerce.date(),
});

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
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      res.json({ posts: await listPosts(status) });
    }),
  );

  router.post(
    '/posts',
    wrap(async (req, res) => {
      const body = parseOr400(QueuePostBody, req.body);
      checkImageCount(body.media.length);
      const media = body.media.map((m) => toPostMedia(m.filename, Buffer.from(m.dataBase64, 'base64'), m.altText));
      const post = await queuePost(body.accountId, body.body, media, body.scheduledFor);
      res.status(201).json({ post });
    }),
  );

  router.delete(
    '/posts/:id',
    wrap(async (req, res) => {
      const id = intParam(req.params.id, 'post id');
      const ok = await cancelPost(id);
      if (!ok) throw new HttpError(409, 'post is not queued (already publishing, posted, or canceled)');
      res.json({ canceled: true });
    }),
  );

  return router;
}
