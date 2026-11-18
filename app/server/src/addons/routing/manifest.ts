import { defineFeature } from '../../features/types.js';

/**
 * The model-routing pilot. Its code (org-router.ts) now lives under `addons/routing/`; the routing
 * subcommands stay on the core `org` command (cli-org.ts imports the router from this folder), and
 * the weekly report timer is wired here. Off unless the vault lists `routing`.
 */
export default defineFeature({
  name: 'routing',
  core: false,
  summary: 'The model-routing pilot: tier selection, the route_decisions ledger and the weekly routing report',
  nav: [],
  cli: [],
  timers: [{
    unit: 'secondbrain-routing-report',
    summary: 'writes the weekly model-routing report (routing pilot)',
    calendar: 'Sun *-*-* 22:00:00',
    command: 'org route report --since 7d --write',
    description: 'Second Brain: write the weekly model-routing report into the vault (dispatch.routing.reportFile in secondbrain.json)',
    timerDescription: 'Second Brain model-routing report, weekly',
    persistent: true,
    randomizedDelaySec: 600,
    service: { after: ['postgresql.service'], requires: ['postgresql.service'], directives: ['TimeoutStartSec=60'] },
  }],
  wrappers: [],
  env: [],
  docs: 'docs/addons.md',
});
