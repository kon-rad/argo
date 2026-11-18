import { defineFeature } from '../../features/types.js';

export default defineFeature({
  name: 'skills',
  core: false,
  summary: 'Skill library, agent assignments, versioned package deployments per machine and a reviewed change workflow',
  nav: [{ section: 'Work', label: 'Skills', path: '/skills' }],
  cli: [{ command: 'skills', entry: 'cli-skills.js', summary: 'skills: list | show | matrix | explain | draft | preview | propose | changes | apply | sync | pack | status | ack (skills help)' }],
  timers: [],
  wrappers: ['cli-skills'],
  health: { label: 'the skills acknowledgement and policy approval tables answer', tables: ['skill_view_acks', 'skill_ack_log', 'skill_policy_approvals'] },
  env: ['SB_LEDGER_TOKEN', 'SECONDBRAIN_SERVER'],
  settings: 'skills',
  docs: 'docs/skills.md',
});
