import { defineFeature } from '../types.js';

export default defineFeature({
  name: 'memory',
  core: true,
  summary: 'Sourced claims every runtime recalls: memory_facts, the candidates finished sessions propose, and retirement',
  nav: [{ section: 'Work', label: 'Memory', path: '/memory' }],
  cli: [{ command: 'memory', entry: 'cli-memory.js', summary: 'the shared memory: recall|remember|list|retire|stats (memory help)' }],
  timers: [],
  wrappers: ['cli-memory'],
  health: { label: 'the memory tables answer', tables: ['memory_facts', 'agent_summary_facts'] },
  env: [],
  settings: 'memory',
  docs: 'docs/memory.md',
});
