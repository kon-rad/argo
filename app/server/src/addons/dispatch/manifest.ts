import { defineFeature } from '../../features/types.js';

/**
 * The engine's zen-agent dispatcher (`dispatch/`). Its code and CLI (`dispatch`) now live under
 * `addons/dispatch/`. Stays a pilot; off unless the vault lists `dispatch` AND the server sets
 * `ORG_DISPATCH=on`. The timer rides this manifest, so deploy installs it only when the module is on.
 */
export default defineFeature({
  name: 'dispatch',
  core: false,
  summary: 'The zen-agent and Codex dispatcher: one run per bot with open wakeups, on a timer (pilot)',
  nav: [],
  cli: [{ command: 'dispatch', entry: 'addons/dispatch/cli.js', summary: 'run zen-agent bots for their open wakeups (tick | routines)' }],
  timers: [{ unit: 'secondbrain-dispatch', summary: 'one dispatcher tick, for zen-agent bots with open wakeups' }],
  wrappers: [],
  env: ['ORG_DISPATCH', 'ORG_DISPATCH_TICK_SECONDS', 'ORG_DISPATCH_PARALLEL', 'ORG_DISPATCH_QUIET', 'ORG_DISPATCH_DAILY_TOKENS', 'ORG_CODEX_COMMAND'],
  docs: 'docs/addons.md',
});
