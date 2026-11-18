import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'garden',
  core: false,
  summary: 'A nightly shelf-keeping pass over Projects/, Areas/ and Research/: headers, archive, stale areas, a wiki block and a report',
  nav: [],
  cli: [{ command: 'garden', entry: 'cli-garden.js', summary: 'run the nightly garden pass (shadow mode unless garden.apply is true)' }],
  timers: [{
    unit: 'secondbrain-garden',
    summary: 'the nightly garden pass',
    calendar: '*-*-* 04:30:00 Asia/Tokyo',
    command: 'garden --write',
    description: 'Second Brain: nightly vault gardener (shelf notes, catalog, archive moves when garden.apply is on)',
    timerDescription: 'Vault gardener, nightly before the morning routines',
    persistent: true,
    randomizedDelaySec: 120,
    service: { after: ['network-online.target', 'postgresql.service'], requires: ['postgresql.service'], directives: ['TimeoutStartSec=900'] },
  }],
  wrappers: [],
  env: [],
  settings: 'garden',
  docs: 'docs/garden.md',
});
