import { join } from 'node:path';
import { config } from '../../config.js';
import type { FeatureRoutes } from '../../features/types.js';
import { voiceRouter } from '../../routes/voice.js';

// Read-aloud through a local speech server (Kokoro). Its settings can also drive a Claude Code
// Stop hook on the same machine, so the routes are never mounted on a server.
export const routes: FeatureRoutes = ({ vaultRoot, remote, opts }) =>
  remote
    ? []
    : [
        {
          path: '/api/voice',
          router: voiceRouter({
            vaultRoot,
            settingsFile: join(config.dataDir, 'voice-settings.json'),
            cacheDir: join(config.dataDir, 'tts'),
            ttsUrl: config.ttsUrl,
            ttsModel: config.ttsModel,
            ...opts.voice,
          }),
        },
      ];
