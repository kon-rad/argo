import { defineFeature } from '../types.js';

export default defineFeature({
  name: 'memory',
  core: true,
  summary: 'Sourced claims every runtime recalls: memory_facts, the candidates finished sessions propose, and retirement',
  nav: [{ section: 'Work', label: 'Memory', path: '/memory' }],
  cli: [{ command: 'memory', entry: 'cli-memory.js', summary: 'the shared memory: recall|remember|list|retire|propose|stats|capture (memory help)' }],
  timers: [{ unit: 'secondbrain-memory-capture', summary: 'captures durable lessons from finished bot wakes into memory_facts, every 5 minutes (memory.capture.everyMinutes sets the real cadence)' }],
  wrappers: ['cli-memory'],
  health: { label: 'the memory tables answer', tables: ['memory_facts', 'agent_summary_facts'] },
  env: [],
  settings: 'memory',
  docs: 'docs/memory.md',
});
