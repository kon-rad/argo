import { defineFeature } from '../../features/types.js';

/**
 * The self-improvement loop from the plan ([[engine-core-v2-proposal]]). A proposal, not shipped:
 * docs only, no code paths, no CLI, no timer. It has a manifest so it appears in `features list`
 * with its Status, and so the shape is ready when it is built.
 */
export default defineFeature({
  name: 'improve',
  core: false,
  summary: 'The self-improvement loop: candidates, an append-only ledger and a ratchet (proposal, docs only)',
  nav: [],
  cli: [],
  timers: [],
  wrappers: [],
  env: [],
  docs: 'docs/addons.md',
});
