import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'agents',
  core: false,
  summary: 'Views over a separately-run agent-hub: Claude Code chats, Hermes history and the cron page',
  nav: [
    { section: 'Work', label: 'Agents', path: '/agents' },
    { section: 'Work', label: 'Cron', path: '/cron' },
  ],
  cli: [{ command: 'agents-sync', entry: 'cli-agents-sync.js', summary: 'pull a host\'s Hermes history into the agent-hub' }],
  timers: [{
    unit: 'secondbrain-agents-sync',
    summary: 'the agents-sync pull, on a timer',
    calendar: '*:0/10',
    command: 'agents-sync',
    description: 'Second Brain: copy Hermes chats and cron history into Postgres',
    timerDescription: 'Second Brain agents sync every 10 minutes',
    persistent: true,
    environment: ['HERMES_HOME=@HERMES_HOME@', 'AGENTS_SYNC_HOST=droplet'],
    service: { after: ['network-online.target', 'postgresql.service'], requires: ['postgresql.service'], directives: ['Nice=10'] },
  }],
  wrappers: [],
  env: ['AGENT_HUB_URL', 'AGENT_HUB_TOKEN', 'ZEN_AGENT_URL', 'ZEN_AGENT_TOKEN', 'HERMES_HOME', 'AGENTS_SYNC_HOST'],
  docs: 'docs/modules.md#agents',
});
