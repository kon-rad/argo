import { defineFeature } from '../types.js';

export default defineFeature({
  name: 'usage',
  core: true,
  summary: 'What your agents cost: a ledger of every run by bot, task, project and host, manifest-selected subscription quotas and API credit balances',
  nav: [{ section: 'Work', label: 'Usage', path: '/usage' }],
  cli: [
    { command: 'usage-sync', entry: 'cli-usage-sync.js', summary: "this machine's Claude Code and Codex usage into the ledger" },
    { command: 'usage-push', entry: 'cli-usage-push.js', summary: 'send new Claude Code and Codex usage to the server ledger over one SSH call' },
    { command: 'usage-backfill', entry: 'cli-usage-backfill.js', summary: 'wire lines for archived sessions (pipe to the server importer)' },
    { command: 'credits', entry: 'cli-credits.js', summary: 'show | set <provider> <balance> | sync  prepaid API credit balances' },
    { command: 'ingest-device', entry: 'cli-ingest-device.js', summary: '(server) device tokens for ledgers: add <host> | list | revoke <id>' },
  ],
  timers: [
    {
      unit: 'secondbrain-usage-sync',
      summary: "the server's own Claude Code usage into the ledger, every 5 minutes",
      calendar: '*:0/5',
      command: 'usage-sync',
      description: 'Second Brain: Claude Code usage, cc-runs logs, plan readings and zen-agent traces into the ledger',
      timerDescription: 'Second Brain usage sync every 5 minutes',
      persistent: true,
      environment: ['USAGE_SYNC_HOST=droplet', 'CLAUDE_PROJECTS_DIR=@APP_HOME@/.claude/projects', 'CC_RUNS_DIR=@APP_HOME@/cc-runs', 'PLAN_USAGE_LOG=@APP_HOME@/.local/share/secondbrain/plan-usage.ndjson'],
      service: { after: ['network-online.target', 'postgresql.service'], requires: ['postgresql.service'], directives: ['Nice=10'] },
    },
    {
      unit: 'secondbrain-credits-sync',
      summary: 'provider credit balances, every 15 minutes',
      calendar: '*:0/15',
      command: 'credits sync',
      description: 'Second Brain: prepaid API credit balances (OpenRouter, fal) into Postgres',
      timerDescription: 'Second Brain credits sync every 15 minutes',
      randomizedDelaySec: 60,
      environment: ['CREDITS_KEYS_FILE=@HERMES_HOME@/.env'],
      service: {
        after: ['network-online.target', 'postgresql.service'],
        wants: ['network-online.target'],
        requires: ['postgresql.service'],
        directives: ['SuccessExitStatus=2', 'Nice=10'],
      },
    },
  ],
  wrappers: [],
  health: { label: 'the usage tables answer', tables: ['usage_runs', 'usage_calls', 'usage_hosts', 'usage_files'] },
  env: ['ORG_CODEX_COMMAND', 'CODEX_HOME', 'USAGE_HOST', 'USAGE_PUSH_HOST', 'USAGE_PUSH_STATE', 'ZEN_SESSIONS_DIR', 'USAGE_SYNC_SERVER', 'USAGE_SYNC_TOKEN'],
  docs: 'docs/modules.md#usage',
});
