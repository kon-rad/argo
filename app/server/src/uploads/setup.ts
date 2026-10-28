import type { Router } from 'express';
import { Router as makeRouter } from 'express';
import { config } from '../config.js';
import { log } from '../logger.js';
import { rcloneRemote } from './remote.js';
import { createWorker, type UploadsDeps } from './service.js';
import { s3Store } from './store.js';
import { uploadsRouter, type UploadsRouterOptions } from '../routes/uploads.js';

export interface UploadsMount {
  router: Router;
  worker: ReturnType<typeof createWorker> | null;
}

/** Builds the module from the environment, or from injected pieces in tests. Unconfigured: every route answers 503. */
export function mountUploads(vaultRoot: string, injected?: Partial<UploadsRouterOptions>): UploadsMount {
  let deps: UploadsDeps | null = null;
  if (injected?.store && injected.remote) {
    deps = { store: injected.store, remote: injected.remote, vaultRoot };
  } else if (config.b2KeyId && config.b2AppKey && config.b2Bucket && config.b2S3Endpoint) {
    deps = {
      store: s3Store({ endpoint: config.b2S3Endpoint, keyId: config.b2KeyId, appKey: config.b2AppKey, bucket: config.b2Bucket }),
      remote: rcloneRemote({
        keyId: config.b2KeyId,
        appKey: config.b2AppKey,
        bucket: config.b2Bucket,
        cryptPassword: config.b2CryptPassword,
        cryptPassword2: config.b2CryptPassword2,
      }),
      vaultRoot,
    };
  }
  if (!deps) {
    log.warn('uploads module is on but B2_KEY_ID, B2_APP_KEY, B2_BUCKET and B2_S3_ENDPOINT are not all set');
    const router = makeRouter();
    router.use((_req, res) => {
      res.status(503).json({ error: 'uploads are not configured on this server' });
    });
    return { router, worker: null };
  }
  const worker = createWorker(deps);
  const router = uploadsRouter({
    ...deps,
    maxBytes: config.uploadsMaxBytes,
    onUploaded: () => worker.kick(),
    ...injected,
  });
  return { router, worker };
}
