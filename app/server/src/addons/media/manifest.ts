import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'media',
  core: false,
  summary: 'A browser over the media files in your vault',
  nav: [{ section: 'Vault', label: 'Media', path: '/media' }],
  cli: [],
  timers: [],
  wrappers: [],
  env: [],
  docs: 'docs/modules.md',
});
