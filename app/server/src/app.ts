import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { addonRoutes } from './addons/index.js';
import { createAuth, type AuthOptions } from './auth/router.js';
import { config, type ModuleName } from './config.js';
import { healthy, runChecks } from './doctor.js';
import { currentTimezone } from './timezone.js';
import { connectors as defaultConnectors, type ConnectorRegistry } from './connectors/index.js';
import { defaultEmbeddingProvider } from './embeddings/factory.js';
import { featureRoutes, mountAt, navFor } from './features/index.js';
import { b2Router, type B2Options } from './routes/b2.js';
import type { BoardRouterOptions } from './routes/board.js';
import type { ChatOptions } from './routes/chat.js';
import { databaseRouter } from './routes/database.js';
import { fileRouter } from './routes/file.js';
import { friendlyRouter, type FriendlyOptions } from './routes/friendly.js';
import { errorHandlerFor } from './routes/http.js';
import type { HubOptions } from './routes/hub.js';
import { knowledgeTokenGate } from './auth/knowledgeToken.js';
import { rawRouter } from './routes/raw.js';
import type { RingRouterOptions } from './routes/ring.js';
import { runsRouter } from './routes/runs.js';
import { searchRouter, type ProviderFactory } from './routes/search.js';
import type { InstagramUnifiedOptions } from './metrics/social/unified.js';
import type { SocialOptions } from './routes/social.js';
import { sourcesRouter } from './routes/sources.js';
import { systemRouter } from './routes/system.js';
import { treeRouter } from './routes/tree.js';
import type { UploadsRouterOptions } from './routes/uploads.js';
import type { VoiceOptions } from './routes/voice.js';
import type { ZenOptions } from './routes/zen.js';
import type { FundDeps } from './fund.js';
import { togetherSqlGenerator, type SqlGenerator } from './sqlgen.js';
import { readBuildInfo, type BuildInfo } from './version.js';

export interface AppOptions {
  /** Desk bootstrap is constructed before listen, only for the enabled addon. */
  desk?: import('./addons/desk/boot.js').DeskBoot;
  /** Overridden in tests so the fund page reads a fake chain and a fake Safe service. */
  fund?: Partial<FundDeps>;
  /** Overridden in tests so a run can be held open and inspected mid-flight. */
  connectors?: ConnectorRegistry;
  /** Overridden in tests so routes read a fixture tree, not the real vault. */
  vaultRoot?: string;
  /** Absent in tests: only the bootstrap knows how to close the server. */
  onShutdown?: () => void;
  /** Overridden in tests so semantic search never makes a network call. */
  embeddingProvider?: ProviderFactory;
  /** Overridden in tests so the Friendly button never boots a real robot. */
  friendly?: Partial<FriendlyOptions>;
  /** Defaults to the DEPLOYMENT env var. */
  deployment?: 'local' | 'server';
  /** Overridden in tests; otherwise built from the AUTH_* env vars. */
  auth?: AuthOptions;
  /** Overridden in tests so the Database page's ask box never calls a model. */
  sqlGenerator?: () => SqlGenerator;
  /** Overridden in tests with a fake `b2store serve`. */
  b2?: B2Options;
  /** Overridden in tests so the ring pull never runs ssh. */
  ring?: Partial<RingRouterOptions>;
  /** uploads module: a fake bucket and vault remote for tests. */
  uploads?: Partial<UploadsRouterOptions>;
  uploadsPullToken?: string;
  /** Overridden in tests so the Cron page never runs systemctl. */
  timers?: () => Promise<{ available: boolean; timers: unknown[] }>;
  /** Optional features to mount. Defaults to the MODULES env var. */
  modules?: ReadonlySet<ModuleName>;
  /** Overridden in tests so /api/meta reports a fixed version and commit. */
  buildInfo?: BuildInfo;
  /** Overridden in tests with a fake agent-hub. */
  hub?: HubOptions;
  /** Overridden in tests with a fake `zen-agent serve`. */
  zen?: ZenOptions;
  /** Overridden in tests: a fixed owner, no live bus. */
  board?: Partial<BoardRouterOptions>;
  /** Overridden in tests; otherwise PROJECTS_FEED_TOKEN. */
  projectsFeedToken?: string;
  /** Test override for KNOWLEDGE_TOKEN. */
  knowledgeToken?: string;
  /** Overridden in tests: temp settings and cache, and a fake speech server. */
  voice?: Partial<VoiceOptions>;
  /** Overridden in tests with fake providers and a fixed encryption key. */
  social?: Partial<SocialOptions>;
  instagramUnified?: Partial<InstagramUnifiedOptions>;
  /** Overridden in tests with a fake chat model and a fixed provider catalog. */
  chat?: Partial<ChatOptions>;
}

function defaultSqlGenerator(): SqlGenerator {
  if (!config.togetherApiKey) throw new Error('TOGETHER_API_KEY is not set, so questions cannot be turned into SQL');
  return togetherSqlGenerator({ apiKey: config.togetherApiKey, model: config.sqlModel });
}

/** Scripts only from this origin; fetches only from this origin plus `connectOrigins` (the bucket, for direct uploads). */
export function contentSecurityPolicy(connectOrigins: string[] = []): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "frame-src 'self'",
    ["connect-src 'self'", ...connectOrigins].join(' '),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}


export function createApp(opts: AppOptions = {}): express.Express {
  const vaultRoot = opts.vaultRoot ?? config.vaultRoot;

  const modules = opts.modules ?? config.modules;
  const deployment = opts.deployment ?? config.deployment;
  const remote = deployment === 'server';

  const app = express();
  app.disable('x-powered-by');
  // Caddy on the same box is the only proxy; trusting exactly loopback makes
  // req.ip the real client for the login throttle and nothing else spoofable.
  if (remote) app.set('trust proxy', 'loopback');

  app.use((_req, res, next) => {
    // SAMEORIGIN, not DENY: the reader frames PDFs from /api/raw.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  // Saving a note carries the whole file; everything else stays at 1 MB. The
  // second parser skips a body the first has already read.
  app.use('/api/file/source', express.json({ limit: '6mb' }));
  // Features come from their manifests, core (features/<name>/) and addon (addons/<name>/) alike:
  // three mount points, raw, public and session. The login is built first so a public route that
  // gates some of its own paths (the board) can use it.
  const auth = remote
    ? createAuth(
        opts.auth ?? {
          passwordHash: config.authPasswordHash!,
          totpSecret: config.authTotpSecret!,
          publicOrigin: config.publicOrigin!,
        },
      )
    : undefined;
  const ctx = { vaultRoot, remote, sessionGate: auth?.requireSession, opts, app };
  const features = [...featureRoutes(modules, ctx), ...addonRoutes(modules, ctx)];
  // Raw: ahead of the global body parser (the usage ingest reads its own large body after checking
  // its token; a queued social post carries its images as base64 and parses before the session check).
  mountAt(app, features, 'raw');
  app.use(express.json({ limit: '1mb' }));

  // The same checks `secondbrain doctor` prints, so a monitor and a person see one
  // answer. `?deep=1` adds the server-only checks (failed timers, last backup);
  // the launcher polls this endpoint while it waits for a boot, so those stay opt-in.
  app.get('/api/health', async (req, res) => {
    const checks = await runChecks({ modules, deep: req.query.deep === '1' });
    res.json({ ok: healthy(checks), checks });
  });

  // Public: a feature route with its own token check (the projects feed, the board, the social OAuth
  // callback, the uploads pull) sits ahead of the login gates.
  mountAt(app, features, 'public');

  if (auth) {
    // A read-only token for a local agent, for three GET paths (auth/knowledgeToken.ts). It only flags the request.
    app.use('/api', knowledgeTokenGate(opts.knowledgeToken ?? config.knowledgeToken));
    app.use('/api', auth.checkOrigin);
    app.use('/api/auth', auth.router);
    // Everything below this line needs a session. Routes are only ever added
    // below it, so a new endpoint is protected by default.
    app.use('/api', (req, res, next) => (res.locals.knowledgeToken ? next() : auth.requireSession(req, res, next)));
  } else {
    app.get('/api/auth/me', (_req, res) => {
      res.json({ required: false, authenticated: true });
    });
  }
  // What the web app shows: optional pages and the vault notes the nav links to.
  // The version and commit are read once: they cannot change while this process runs.
  const buildInfo = opts.buildInfo ?? readBuildInfo(config.appRoot);
  app.get('/api/meta', (_req, res) => {
    res.json({
      modules: [...modules],
      // The header links of the features that are on, from their manifests.
      nav: navFor(modules),
      owner: config.ownerName,
      devLogPath: config.devLogPath,
      docsPath: config.docsPath,
      robot: !remote && Boolean(config.robotLaunchScript),
      // The vault's current time zone (secondbrain.json), read fresh so `secondbrain timezone set` needs no restart; null: unset.
      timezone: currentTimezone(),
      ...buildInfo,
    });
  });
  app.use('/api/tree', treeRouter(vaultRoot));
  app.use('/api/file', fileRouter(vaultRoot));
  app.use('/api/raw', rawRouter(vaultRoot));
  app.use('/api/b2', b2Router(vaultRoot, opts.b2 ?? { serveUrl: config.b2ServeUrl }));
  app.use(
    '/api/search',
    searchRouter(opts.embeddingProvider ?? defaultEmbeddingProvider, [
      'notes',
      'records',
      ...(modules.has('agents') || modules.has('usage') ? (['agents'] as const) : []),
    ]),
  );
  app.use('/api/sources', sourcesRouter(opts.connectors ?? defaultConnectors));
  app.use('/api/runs', runsRouter());
  app.use('/api/db', databaseRouter(opts.sqlGenerator ?? defaultSqlGenerator));
  // Session: the rest of the features' routes, behind the login like everything below. A module
  // that is off is not mounted at all, so its API 404s like any unknown path.
  mountAt(app, features, 'session');
  // Local-only: one spawns a shell script, the other stops the process. Neither
  // belongs on an internet-facing box, logged in or not.
  const robotScript = opts.friendly?.script ?? config.robotLaunchScript;
  if (!remote && robotScript) {
    app.use(
      '/api/friendly',
      friendlyRouter({
        script: robotScript,
        logFile: join(config.dataDir, 'friendly-launch.log'),
        ...opts.friendly,
      }),
    );
  }
  app.use('/api', systemRouter(vaultRoot, remote ? undefined : opts.onShutdown));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { message: 'no such endpoint' } });
  });

  // In production Express serves the built SPA; in dev Vite does, and this
  // whole branch is inert because web/dist does not exist yet.
  const index = join(config.webDist, 'index.html');
  if (existsSync(index)) {
    app.use(express.static(config.webDist, { index: false }));
    // The uploads page PUTs file parts straight to the bucket, so the browser must be allowed to reach its origin.
    const csp = contentSecurityPolicy(config.b2S3Endpoint && modules.has('uploads') ? [new URL(config.b2S3Endpoint).origin] : []);
    app.get(/.*/, (_req, res) => {
      // Scripts only from this origin: markdown from the vault is rendered by
      // React (no raw HTML), and this is the backstop if that ever changes.
      res.setHeader('Content-Security-Policy', csp);
      res.sendFile(index);
    });
  }

  app.use(errorHandlerFor(!remote));
  return app;
}
