import { config } from '../../config.js';
import type { FeatureRoutes } from '../../features/types.js';
import { ringRouter } from '../../routes/ring.js';

export const routes: FeatureRoutes = ({ remote, opts }) => {
  const host = config.ringPullHost;
  return [
    {
      path: '/api/ring',
      router: ringRouter({
        allowPull: !remote && config.indexer && Boolean(host),
        host: host ?? '',
        db: config.ringPullDb,
        ...opts.ring,
      }),
    },
  ];
};
