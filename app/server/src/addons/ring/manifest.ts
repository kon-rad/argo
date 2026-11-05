import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'ring',
  core: false,
  summary: 'Stores data from a wearable ring that a separate client pushes in, next to your notes',
  nav: [{ section: 'Life', label: 'Ring', path: '/ring' }],
  cli: [{ command: 'ring-pull', entry: 'cli-ring.js', summary: 'mirror a server\'s ring tables into this one' }],
  timers: [],
  wrappers: [],
  env: ['RING_PULL_SSH_HOST', 'RING_PULL_DB'],
  docs: 'docs/modules.md#ring',
});
