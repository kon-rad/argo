import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'social',
  core: false,
  summary: 'Schedule and publish posts with images or a video to LinkedIn, and to Instagram/YouTube/X through Buffer',
  nav: [],
  cli: [
    {
      command: 'social',
      entry: 'cli-social.js',
      summary: 'the social queue: status | list | add | publish | reauth | run (no command = one pass)',
    },
  ],
  timers: [{
    unit: 'secondbrain-social',
    summary: 'publish due posts, check relayed ones, and the reauth check',
    calendar: '*-*-* *:*:00',
    command: 'social',
    description: 'Second Brain: publish due social posts, check for accounts needing reauth',
    timerDescription: 'Second Brain social posting scheduler, every minute',
    accuracySec: '5s',
    service: {
      after: ['network-online.target', 'postgresql.service'],
      requires: ['postgresql.service'],
      directives: ['SuccessExitStatus=2', 'TimeoutStartSec=300'],
    },
  }],
  wrappers: ['cli-social'],
  env: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET', 'FACEBOOK_LOGIN_CONFIG_ID', 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'SOCIAL_REDIRECT_BASE_URL', 'SOCIAL_TOKEN_ENC_KEY', 'BUFFER_API_KEY', 'SOCIAL_MEDIA_BASE_URL', 'SOCIAL_X_MAX_CHARS'],
  docs: 'docs/modules.md#social',
});
