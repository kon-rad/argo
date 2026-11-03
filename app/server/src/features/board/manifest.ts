import { defineFeature } from '../types.js';

export default defineFeature({
  name: 'board',
  core: true,
  summary: 'The kanban board: cards for people and agents, claimed and finished by lanes, reachable from any machine with a per-device token',
  nav: [{ section: 'Work', label: 'Board', path: '/board' }],
  cli: [{ command: 'board', entry: 'cli-board.js', summary: 'the kanban board: list/show/create/comment/assign/move/claim/finish/token/import (board help)' }],
  timers: [{ unit: 'secondbrain-board-reclaim', summary: 'returns cards whose lane lease expired, every 5 minutes' }],
  wrappers: ['cli-board'],
  env: ['BOARD_URL', 'BOARD_TOKEN', 'ORG_AGENT', 'AGENT_HUB_URL', 'AGENT_HUB_TOKEN'],
  docs: 'docs/kanban-board.md',
});
