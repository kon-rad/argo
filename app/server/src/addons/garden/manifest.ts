import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'garden',
  core: false,
  summary: 'A nightly shelf-keeping pass over Projects/, Areas/ and Research/: headers, archive, stale areas, a wiki block and a report',
  nav: [],
  cli: [{ command: 'garden', entry: 'cli-garden.js', summary: 'run the nightly garden pass (shadow mode unless garden.apply is true)' }],
  timers: [{ unit: 'secondbrain-garden', summary: 'the nightly garden pass' }],
  wrappers: [],
  env: [],
  settings: 'garden',
  docs: 'docs/garden.md',
});
