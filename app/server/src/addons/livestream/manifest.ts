import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'livestream',
  core: false,
  summary: 'A poller that writes a public JSON of stream stats (viewers, hours) for YouTube, Twitch and Kick',
  nav: [],
  cli: [{ command: 'livestream', entry: 'cli-livestream.js', summary: 'the livestream feed: sync | list' }],
  timers: [{ unit: 'secondbrain-livestream', summary: 'the minute poller that writes the public summary JSON' }],
  wrappers: ['cli-livestream'],
  env: ['LIVESTREAM_YOUTUBE', 'LIVESTREAM_TWITCH', 'LIVESTREAM_KICK', 'LIVESTREAM_PUBLIC_DIR'],
  settings: 'livestream',
  docs: 'docs/modules.md#livestream',
});
