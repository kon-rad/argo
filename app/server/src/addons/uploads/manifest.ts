import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'uploads',
  core: false,
  summary: 'Send very large files (1 GB to 50 GB) from a browser straight into the vault\'s B2 bucket',
  nav: [],
  cli: [],
  timers: [],
  wrappers: [],
  env: ['UPLOADS_MAX_GB', 'UPLOADS_PULL_TOKEN'],
  docs: 'docs/uploads.md',
});
