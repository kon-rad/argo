import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { createAuth, type AuthOptions } from './auth/router.js';
import { config, type ModuleName } from './config.js';
import { connectors as defaultConnectors, type ConnectorRegistry } from './connectors/index.js';
import { defaultEmbeddingProvider } from './embeddings/factory.js';
import { agentsRouter } from './routes/agents.js';
import { b2Router, type B2Options } from './routes/b2.js';
import { errorHandlerFor } from './routes/http.js';
import { databaseRouter } from './routes/database.js';
import { fileRouter } from './routes/file.js';
import { hubRouter, type HubOptions } from './routes/hub.js';
import { friendlyRouter, type FriendlyOptions } from './routes/friendly.js';
import { rawRouter } from './routes/raw.js';
import { ringRouter, type RingRouterOptions } from './routes/ring.js';
import { runsRouter } from './routes/runs.js';
import { searchRouter, type ProviderFactory } from './routes/search.js';
import { sourcesRouter } from './routes/sources.js';
import { systemRouter } from './routes/system.js';
import { treeRouter } from './routes/tree.js';
import { togetherSqlGenerator, type SqlGenerator } from './sqlgen.js';

export interface AppOptions {
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
  /** Overridden in tests so the Cron page never runs systemctl. */
  timers?: () => Promise<{ available: boolean; timers: unknown[] }>;
  /** Optional features to mount. Defaults to the MODULES env var. */
  modules?: ReadonlySet<ModuleName>;
  /** Overridden in tests with a fake agent-hub. */
  hub?: HubOptions;
}

function defaultSqlGenerator(): SqlGenerator {
  if (!config.togetherApiKey) throw new Error('TOGETHER_API_KEY is not set, so questions cannot be turned into SQL');
  return togetherSqlGenerator({ apiKey: config.togetherApiKey, model: config.sqlModel });
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
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  if (remote) {
    const auth = createAuth(
      opts.auth ?? {
        passwordHash: config.authPasswordHash!,
        totpSecret: config.authTotpSecret!,
        publicOrigin: config.publicOrigin!,
      },
    );
    app.use('/api', auth.checkOrigin);
    app.use('/api/auth', auth.router);
    // Everything below this line needs a session. Routes are only ever added
    // below it, so a new endpoint is protected by default.
    app.use('/api', auth.requireSession);
  } else {
    app.get('/api/auth/me', (_req, res) => {
      res.json({ required: false, authenticated: true });
    });
  }
  // What the web app shows: optional pages and the vault notes the nav links to.
  app.get('/api/meta', (_req, res) => {
    res.json({
      modules: [...modules],
      owner: config.ownerName,
      devLogPath: config.devLogPath,
      docsPath: config.docsPath,
      robot: !remote && Boolean(config.robotLaunchScript),
    });
  });
  app.use('/api/tree', treeRouter(vaultRoot));
  app.use('/api/file', fileRouter(vaultRoot));
  app.use('/api/raw', rawRouter(vaultRoot));
  app.use('/api/b2', b2Router(vaultRoot, opts.b2 ?? { serveUrl: config.b2ServeUrl }));
  app.use('/api/search', searchRouter(opts.embeddingProvider ?? defaultEmbeddingProvider));
  app.use('/api/sources', sourcesRouter(opts.connectors ?? defaultConnectors));
  app.use('/api/runs', runsRouter());
  app.use('/api/db', databaseRouter(opts.sqlGenerator ?? defaultSqlGenerator));
  // Optional modules: off means not mounted at all, so their API 404s like any unknown path.
  if (modules.has('ring')) {
    const host = config.ringPullHost;
    app.use(
      '/api/ring',
      ringRouter({ allowPull: !remote && Boolean(host), host: host ?? '', db: config.ringPullDb, ...opts.ring }),
    );
  }
  if (modules.has('agents')) {
    app.use('/api/agents', agentsRouter(opts.timers));
    app.use('/api/hub', hubRouter(opts.hub ?? { url: config.agentHubUrl, token: config.agentHubToken }));
  }
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
    app.get(/.*/, (_req, res) => {
      // Scripts only from this origin: markdown from the vault is rendered by
      // React (no raw HTML), and this is the backstop if that ever changes.
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: https:",
          "media-src 'self' blob:",
          "frame-src 'self'",
          "connect-src 'self'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'self'",
          "frame-ancestors 'self'",
        ].join('; '),
      );
      res.sendFile(index);
    });
  }

  app.use(errorHandlerFor(!remote));
  return app;
}
