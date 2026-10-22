import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { createAuth, type AuthOptions } from './auth/router.js';
import { config, type ModuleName } from './config.js';
import { connectors as defaultConnectors, type ConnectorRegistry } from './connectors/index.js';
import { defaultEmbeddingProvider } from './embeddings/factory.js';
import { agentsRouter } from './routes/agents.js';
import { tvRouter } from './routes/tv.js';
import { usageRouter } from './routes/usage.js';
import { b2Router, type B2Options } from './routes/b2.js';
import { errorHandlerFor } from './routes/http.js';
import { databaseRouter } from './routes/database.js';
import { fileRouter } from './routes/file.js';
import { ingestRouter } from './routes/ingest.js';
import { hubRouter, type HubOptions } from './routes/hub.js';
import { mapRouter } from './routes/map.js';
import { mediaRouter } from './routes/media.js';
import { orgRouter } from './routes/org.js';
import { friendlyRouter, type FriendlyOptions } from './routes/friendly.js';
import { rawRouter } from './routes/raw.js';
import { projectsFeedRouter, projectsRouter } from './routes/projects.js';
import { ringRouter, type RingRouterOptions } from './routes/ring.js';
import { runsRouter } from './routes/runs.js';
import { searchRouter, type ProviderFactory } from './routes/search.js';
import { socialCallbackRouter, socialRouter, type SocialOptions } from './routes/social.js';
import { sourcesRouter } from './routes/sources.js';
import { systemRouter } from './routes/system.js';
import { treeRouter } from './routes/tree.js';
import { voiceRouter, type VoiceOptions } from './routes/voice.js';
import { bufferProvider } from './social/providers/buffer.js';
import { linkedinProvider } from './social/providers/linkedin.js';
import { BUFFER_PROVIDER_KEY } from './social/scheduler.js';
import type { SocialProvider } from './social/providers/types.js';
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
  /** Overridden in tests; otherwise PROJECTS_FEED_TOKEN. */
  projectsFeedToken?: string;
  /** Overridden in tests: temp settings and cache, and a fake speech server. */
  voice?: Partial<VoiceOptions>;
  /** Overridden in tests with fake providers and a fixed encryption key. */
  social?: Partial<SocialOptions>;
}

function defaultSqlGenerator(): SqlGenerator {
  if (!config.togetherApiKey) throw new Error('TOGETHER_API_KEY is not set, so questions cannot be turned into SQL');
  return togetherSqlGenerator({ apiKey: config.togetherApiKey, model: config.sqlModel });
}

/** Only LinkedIn is wired today; an unconfigured provider is simply absent, not an error. */
function defaultSocialProviders(): Record<string, SocialProvider> {
  const providers: Record<string, SocialProvider> = {};
  if (config.linkedinClientId && config.linkedinClientSecret) {
    providers.linkedin = linkedinProvider({ clientId: config.linkedinClientId, clientSecret: config.linkedinClientSecret });
  }
  if (config.bufferApiKey) providers[BUFFER_PROVIDER_KEY] = bufferProvider({ apiKey: config.bufferApiKey });
  return providers;
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
  // Each machine's agent ledger syncs here with a device token, no session (usage module). Mounted
  // ahead of the global parser: the router checks the token before it reads its large body.
  if (modules.has('usage')) app.use('/api/ingest', ingestRouter());
  // A queued social post carries its images as base64 (4 x 5 MB at most). Like the
  // note saver above, it parses before the session check, which still refuses it.
  app.use('/api/social/posts', express.json({ limit: '30mb' }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // A kiosk's read-only projects summary: a bearer token, no session.
  if (modules.has('projects')) {
    app.use('/api/feed', projectsFeedRouter(vaultRoot, opts.projectsFeedToken ?? config.projectsFeedToken));
  }

  // The OAuth callback (the provider's redirect arrives without the session
  // cookie) and the public media a relay fetches by token.
  const socialOpts: SocialOptions | undefined = modules.has('social')
    ? {
        providers: defaultSocialProviders(),
        tokenEncKey: config.socialTokenEncKey,
        redirectBaseUrl: config.socialRedirectBaseUrl,
        xMaxChars: config.socialXMaxChars,
        ...opts.social,
      }
    : undefined;
  if (socialOpts) app.use('/api/social', socialCallbackRouter(socialOpts));

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
  // Optional modules: off means not mounted at all, so their API 404s like any unknown path.
  if (modules.has('ring')) {
    const host = config.ringPullHost;
    app.use(
      '/api/ring',
      ringRouter({
        allowPull: !remote && config.indexer && Boolean(host),
        host: host ?? '',
        db: config.ringPullDb,
        ...opts.ring,
      }),
    );
  }
  if (modules.has('agents')) {
    app.use('/api/agents', agentsRouter(opts.timers));
    app.use('/api/hub', hubRouter(opts.hub ?? { url: config.agentHubUrl, token: config.agentHubToken }));
  }
  if (modules.has('usage')) app.use('/api/usage', usageRouter());
  if (modules.has('projects')) app.use('/api/projects', projectsRouter(vaultRoot));
  if (modules.has('org')) app.use('/api/org', orgRouter(vaultRoot));
  if (modules.has('map')) app.use('/api/map', mapRouter());
  if (modules.has('tv')) app.use('/api/tv', tvRouter(vaultRoot));
  if (modules.has('media')) app.use('/api/media', mediaRouter(vaultRoot));
  if (socialOpts) app.use('/api/social', socialRouter(socialOpts));
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
  // Read-aloud through a local speech server (Kokoro). Its settings can also
  // drive a Claude Code Stop hook on the same machine. Never on a server.
  if (!remote && modules.has('voice')) {
    app.use(
      '/api/voice',
      voiceRouter({
        vaultRoot,
        settingsFile: join(config.dataDir, 'voice-settings.json'),
        cacheDir: join(config.dataDir, 'tts'),
        ttsUrl: config.ttsUrl,
        ttsModel: config.ttsModel,
        ...opts.voice,
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
