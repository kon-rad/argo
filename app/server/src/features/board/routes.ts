import { config } from '../../config.js';
import { boardRouter } from '../../routes/board.js';
import type { FeatureRoutes } from '../types.js';

// The board takes a per-machine bearer token as well as a session, so it sits ahead of BOTH gates
// (checkOrigin and requireSession) and applies its own gate to requests without a token. A bearer-token
// client (a lane on another machine, a CLI over HTTPS) sends no Origin and no session cookie, so mounting
// this after checkOrigin made every non-GET board call 403 "cross-origin request refused" before the
// board's own token check ever ran (docs/zen-runtime.md phase 2 pilot, 2026-10-25).
export const routes: FeatureRoutes = ({ sessionGate, opts }) => [
  {
    path: '/api/board',
    router: boardRouter({
      ...(sessionGate ? { sessionGate } : {}),
      hub: opts.hub ?? { url: config.agentHubUrl, token: config.agentHubToken },
      ...opts.board,
    }),
    mount: 'public',
  },
];
