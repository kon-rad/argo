import { createApp } from './app.js';
import { config } from './config.js';
import { connectors } from './connectors/index.js';
import { pool } from './db.js';
import { loadEmbeddingConfig } from './embeddings/factory.js';
import { log } from './logger.js';
import * as queue from './queue.js';
import { startAutoSync } from './schedule.js';

const app = createApp({
  // POST /api/shutdown is how the menu-bar launcher stops the server; without
  // this the endpoint exists but can only answer 501.
  onShutdown: () => {
    void shutdown('http').then(() => process.exit(0));
  },
});

// 127.0.0.1 only, in both deployments. On the Mac localhost IS the security
// boundary. On the server Caddy terminates TLS on the same box and proxies in,
// so the app itself is never reachable from the network without passing
// through HTTPS and the login.
const server = app.listen(config.port, '127.0.0.1', () => {
  log.info(`second brain listening on http://127.0.0.1:${config.port}`);
  log.info(`vault root: ${config.vaultRoot}`);
  // Non-fatal: without it semantic search answers 503 and everything else
  // works exactly as before.
  void loadEmbeddingConfig().catch((err) => log.warn('embedding config unavailable:', err));
  log.info(`deployment: ${config.deployment}${config.deployment === 'server' ? ` (login required, origin ${config.publicOrigin})` : ''}`);
  if (config.scanIntervalMinutes > 0) startAutoSync(connectors, config.scanIntervalMinutes);
  (app.locals['uploadsWorker'] as { start(): void } | null | undefined)?.start();
});

let shuttingDown = false;

export async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutting down (${reason})`);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await queue.drain().catch((err) => log.warn('queue drain failed:', err));
  await pool.end().catch(() => {});
  log.info('goodbye');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal).then(() => process.exit(0));
  });
}
