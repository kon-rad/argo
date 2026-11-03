import { defineFeature } from '../types.js';

export default defineFeature({
  name: 'summaries',
  core: true,
  summary: 'One model-written summary per finished agent session, with counted metrics and the facts it proposes for memory',
  // Shown as a tab of the usage page; no page of its own yet.
  nav: [],
  cli: [
    { command: 'summarize', entry: 'cli-summarize.js', summary: 'summarize finished agent sessions (--digest for the stand-up)' },
    { command: 'summarize-eval', entry: 'cli-summarize-eval.js', summary: 'grade summaries against transcripts: --golden | --references | --sample N [--judge]' },
  ],
  timers: [{ unit: 'secondbrain-summarize', summary: 'summarizes up to 50 finished sessions every 30 minutes' }],
  wrappers: [],
  env: ['SUMMARIES_M1_URL'],
  settings: 'summaries',
  docs: 'docs/summaries.md',
});
