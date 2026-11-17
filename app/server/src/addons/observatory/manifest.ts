import { defineFeature } from '../../features/types.js';
export default defineFeature({ name: 'observatory', core: false,
  summary: 'Bounded evidence windows and deterministic execution replay with explicit coverage gaps',
  nav: [], cli: [], timers: [], wrappers: [], env: [], docs: 'docs/observatory.md',
  health: { label: 'the observatory evidence tables answer', tables: ['archive_messages', 'archive_sessions', 'usage_runs', 'usage_calls', 'card_events', 'org_messages'] },
});
