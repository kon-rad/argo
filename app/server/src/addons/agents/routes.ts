import { config } from '../../config.js';
import type { FeatureRoutes } from '../../features/types.js';
import { agentsRouter } from '../../routes/agents.js';
import { hubRouter } from '../../routes/hub.js';
import { presetsRouter } from '../../routes/presets.js';
import { zenRouter } from '../../routes/zen.js';

// The agent-hub views, the hub and zen proxies and the presets page. All session-gated; the
// agent-hub process itself is not shipped by the engine (docs/modules.md#agents).
export const routes: FeatureRoutes = ({ opts }) => [
  { path: '/api/agents', router: agentsRouter(opts.timers) },
  { path: '/api/hub', router: hubRouter(opts.hub ?? { url: config.agentHubUrl, token: config.agentHubToken }) },
  { path: '/api/zen', router: zenRouter(opts.zen ?? { url: config.zenAgentUrl, token: config.zenAgentToken }) },
  { path: '/api/presets', router: presetsRouter() },
];
