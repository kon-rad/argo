import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'data',
  core: false,
  summary: 'Every table, connector, scheduled job and dashboard on one page; the vault owns its tables (SQL migrations) and connectors (JSON-lines scripts)',
  nav: [{ section: 'Vault', label: 'Data', path: '/data' }],
  cli: [{ command: 'data', entry: 'cli-data.js', summary: 'migrate | run <connector> [-- args] | run --due | status | tables' }],
  timers: [{
    unit: 'secondbrain-data-run',
    summary: 'run every due data connector',
    calendar: '*:0/15',
    command: 'data run --due',
    description: 'Second Brain: run due data connectors',
    timerDescription: 'Data connectors, checked every 15 minutes',
    persistent: true,
    service: {
      after: ['network-online.target', 'postgresql.service'],
      requires: ['postgresql.service'],
      directives: ['SuccessExitStatus=2', 'TimeoutStartSec=7200'],
    },
  }],
  wrappers: [],
  health: { label: 'the data ledger answers', tables: ['data_migrations'] },
  env: [],
  settings: 'data',
  docs: 'docs/data.md',
});
