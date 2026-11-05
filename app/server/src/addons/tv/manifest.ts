import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'tv',
  core: false,
  summary: 'A player for video episodes kept in your vault, with a kiosk mode for a TV',
  nav: [],
  cli: [],
  timers: [],
  wrappers: [],
  env: [],
  settings: 'tv',
  docs: 'docs/modules.md#tv',
});
