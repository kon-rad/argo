import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'map',
  core: false,
  summary: 'A 3D map of your vault, projects and goals, with daily metrics on top',
  nav: [{ section: 'Vault', label: 'Brain map', path: '/map' }],
  cli: [
    { command: 'map-build', entry: 'cli-map.js', summary: 'build the brain map data' },
    { command: 'metrics', entry: 'cli-metrics.js', summary: 'write the daily metrics the map shows' },
    { command: 'backlinks', entry: 'cli-backlinks.js', summary: 'write a "related" block at the end of notes from their links (dry run unless --write)' },
  ],
  timers: [
    { unit: 'secondbrain-map-build', summary: 'rebuild the brain map, hourly' },
    { unit: 'secondbrain-metrics', summary: 'write the daily metrics, daily' },
  ],
  wrappers: [],
  // Both optional: the social metrics collectors (docs/social-metrics.md) report a missing key per account.
  env: ['YOUTUBE_API_KEY', 'SOCIAL_TOKEN_ENC_KEY'],
  docs: 'docs/modules.md#map',
});
