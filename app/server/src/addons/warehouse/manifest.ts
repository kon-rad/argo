import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'warehouse',
  core: false,
  summary: 'Every table, connector, scheduled job and dashboard on one page; the vault owns its tables (SQL migrations) and connectors (JSON-lines scripts)',
  nav: [{ section: 'Vault', label: 'Warehouse', path: '/warehouse' }],
  cli: [{ command: 'warehouse', entry: 'cli-warehouse.js', summary: 'migrate | run <connector> [-- args] | run --due | status | tables' }],
  timers: [{
    unit: 'secondbrain-warehouse-run',
    summary: 'run every due warehouse connector',
    calendar: '*:0/15',
    command: 'warehouse run --due',
    description: 'Second Brain: run due warehouse connectors',
    timerDescription: 'Warehouse connectors, checked every 15 minutes',
    persistent: true,
    service: {
      after: ['network-online.target', 'postgresql.service'],
      requires: ['postgresql.service'],
      directives: ['SuccessExitStatus=2', 'TimeoutStartSec=7200'],
    },
  }],
  wrappers: [],
  health: { label: 'the warehouse ledger answers', tables: ['data_migrations'] },
  env: [],
  settings: 'warehouse',
  docs: 'docs/warehouse.md',
});
