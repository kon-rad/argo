import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'voice',
  core: false,
  summary: 'Read a note aloud through a local OpenAI-compatible speech server. Local only: never mounted on a server',
  nav: [],
  cli: [],
  timers: [],
  wrappers: [],
  env: ['TTS_URL', 'TTS_MODEL'],
  docs: 'docs/modules.md#voice',
});
