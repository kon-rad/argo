import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'livestream',
  core: false,
  summary: 'A poller that writes a public JSON of stream stats (viewers, hours) for YouTube, Twitch and Kick',
  nav: [],
  cli: [{ command: 'livestream', entry: 'cli-livestream.js', summary: 'the livestream feed: sync | list' }],
  timers: [{
    unit: 'secondbrain-livestream',
    summary: 'the minute poller that writes the public summary JSON',
    calendar: '*-*-* *:*:00',
    command: 'livestream',
    description: 'Second Brain: sample YouTube live viewers into Postgres, write the public livestream.json',
    timerDescription: 'Second Brain livestream viewers, every minute',
    accuracySec: '5s',
    environment: ['LIVESTREAM_PUBLIC_DIR=/var/lib/secondbrain-public'],
    service: {
      after: ['network-online.target', 'postgresql.service'],
      requires: ['postgresql.service'],
      directives: ['StateDirectory=secondbrain-public', 'StateDirectoryMode=0755', 'SuccessExitStatus=2', 'TimeoutStartSec=50'],
    },
  }],
  wrappers: ['cli-livestream'],
  env: ['LIVESTREAM_YOUTUBE', 'LIVESTREAM_TWITCH', 'LIVESTREAM_KICK', 'LIVESTREAM_PUBLIC_DIR'],
  settings: 'livestream',
  docs: 'docs/modules.md#livestream',
});
