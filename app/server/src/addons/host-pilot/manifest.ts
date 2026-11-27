import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'host-pilot', core: false, summary: 'Run a registered text command on an enrolled machine',
  cli: [{ command: 'host-worker', entry: 'cli-host-worker.js', summary: 'poll for host commands' }],
  nav: [], timers: [], wrappers: [], env: ['SECONDBRAIN_HOST_TOKEN'], docs: 'docs/host-command-pilot.md',
});
