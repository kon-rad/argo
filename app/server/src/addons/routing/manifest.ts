import { defineFeature } from '../../features/types.js';

/**
 * The model-routing pilot. Its code (org-router.ts, the route_decisions / route_outcomes tables and
 * the routing subcommands inside `cli-org`) still lives in the core tree; only its weekly report timer
 * is wired here, moved off the org manifest. Off unless the vault lists `routing`.
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
