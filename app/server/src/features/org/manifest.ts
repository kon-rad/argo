import { defineFeature } from '../types.js';

export default defineFeature({
  name: 'org',
  core: true,
  summary: 'A company of named AI agents: teams, channels, messages, wakes, the ship gate and plan|apply from the org config',
  nav: [{ section: 'Work', label: 'Org', path: '/org' }],
  cli: [{ command: 'org', entry: 'cli-org.js', summary: 'the agent company: whoami/read/post/dm/handoff/ask-owner/standup/plan/apply (org help)' }],
  // The routing report timer now rides the `routing` addon manifest, so the routing pilot can be
  // turned off without touching the org feature (proposal phase 5).
  timers: [],
  wrappers: ['cli-org'],
  health: { label: 'the org tables answer', tables: ['org_agents', 'org_channels', 'org_messages', 'org_wakeups', 'org_approvals'] },
  env: ['ORG_AGENT', 'ORG_DISPATCH', 'ORG_DB_URL'],
  settings: 'org',
  docs: 'docs/agent-company.md',
});
