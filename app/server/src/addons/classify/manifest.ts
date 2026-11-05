import { defineFeature } from '../../features/types.js';

/**
 * The wake gate (`classify/`, `org-classify.ts`): one calibrated decision about a state, logged to
 * classify_decisions. Its code lives under `addons/classify/` and its CLI (`classify`) is registered
 * here. A pilot: one provider configured, so the step has not run. Off unless the vault lists `classify`.
 */
export default defineFeature({
  name: 'classify',
  core: false,
  summary: 'One calibrated decision about a message, card or run, logged to classify_decisions (the wake gate)',
  nav: [],
  cli: [{ command: 'classify', entry: 'addons/classify/cli.js', summary: 'a calibrated decision about a message, card or run, logged (classify help)' }],
  timers: [],
  wrappers: [],
  env: [],
  docs: 'docs/addons.md',
});
