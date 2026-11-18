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
  timers: [{
    unit: 'secondbrain-summarize',
    summary: 'summarizes up to 50 finished sessions every 30 minutes',
    calendar: '*:0/30',
    command: 'summarize --limit 50',
    description: 'Second Brain: summarize finished agent sessions (local model first, then Together, then OpenRouter)',
    timerDescription: 'Second Brain: summarize finished agent sessions every 30 minutes',
    persistent: true,
    service: {
      after: ['network-online.target', 'postgresql.service'],
      wants: ['network-online.target'],
      requires: ['postgresql.service'],
      directives: ['TimeoutStartSec=1800', 'Nice=10'],
    },
  }],
  wrappers: [],
  health: { label: 'the summaries tables answer', tables: ['agent_summaries', 'agent_summary_facts'] },
  // Optional: a home server's local model address when a vault puts one first in the chain.
  env: ['SUMMARIES_LOCAL_URL'],
  settings: 'summaries',
  docs: 'docs/summaries.md',
});
