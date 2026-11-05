import { defineFeature } from '../types.js';

export default defineFeature({
  name: 'usage',
  core: true,
  summary: 'What your agents cost: a ledger of every run by bot, task, project and host, plan percentages and API credit balances',
  nav: [{ section: 'Work', label: 'Usage', path: '/usage' }],
  cli: [
    { command: 'usage-sync', entry: 'cli-usage-sync.js', summary: "this machine's Claude Code usage into the ledger" },
    { command: 'usage-push', entry: 'cli-usage-push.js', summary: 'send new Claude Code usage to the server ledger over one SSH call' },
    { command: 'usage-backfill', entry: 'cli-usage-backfill.js', summary: 'wire lines for archived sessions (pipe to the server importer)' },
    { command: 'credits', entry: 'cli-credits.js', summary: 'show | set <provider> <balance> | sync  prepaid API credit balances' },
    { command: 'ingest-device', entry: 'cli-ingest-device.js', summary: '(server) device tokens for ledgers: add <host> | list | revoke <id>' },
  ],
  timers: [
    { unit: 'secondbrain-usage-sync', summary: "the server's own Claude Code usage into the ledger, every 5 minutes" },
    { unit: 'secondbrain-credits-sync', summary: 'provider credit balances, every 15 minutes' },
  ],
  wrappers: [],
  health: { label: 'the usage tables answer', tables: ['usage_runs', 'usage_calls', 'usage_hosts', 'usage_files'] },
  env: ['ZEN_SESSIONS_DIR', 'USAGE_SYNC_SERVER', 'USAGE_SYNC_TOKEN'],
  docs: 'docs/modules.md#usage',
});
