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
  timers: [{ unit: 'secondbrain-routing-report', summary: 'writes the weekly model-routing report (routing pilot)' }],
  wrappers: [],
  env: [],
  docs: 'docs/addons.md',
});
