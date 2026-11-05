import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'agents',
  core: false,
  summary: 'Views over a separately-run agent-hub: Claude Code chats, Hermes history and the cron page',
  nav: [],
  cli: [{ command: 'agents-sync', entry: 'cli-agents-sync.js', summary: 'pull a host\'s Hermes history into the agent-hub' }],
  timers: [{ unit: 'secondbrain-agents-sync', summary: 'the agents-sync pull, on a timer' }],
  wrappers: [],
  env: ['AGENT_HUB_URL', 'AGENT_HUB_TOKEN', 'ZEN_AGENT_URL', 'ZEN_AGENT_TOKEN', 'HERMES_HOME', 'AGENTS_SYNC_HOST'],
  docs: 'docs/modules.md#agents',
});
