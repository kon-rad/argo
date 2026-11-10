import { defineFeature } from '../types.js';

export default defineFeature({
  name: 'board',
  core: true,
  summary: 'The kanban board: cards for people and agents, claimed and finished by lanes, reachable from any machine with a per-device token',
  nav: [{ section: 'Work', label: 'Board', path: '/board' }],
  cli: [{ command: 'review', entry: 'cli-review.js', summary: 'owner-managed automatic code review: scope policy|schema|forecast|actual | fixture | tick|stage|retries /absolute/host-policy.json' }, { command: 'board', entry: 'cli-board.js', summary: 'the kanban board: list/show/create/comment/assign/move/claim/finish/token/import (board help)' }],
  timers: [{ unit: 'secondbrain-board-reclaim', summary: 'returns cards whose lane lease expired, every 5 minutes' }],
  wrappers: ['cli-board'],
  health: { label: 'the board tables answer', tables: ['boards', 'cards', 'card_comments', 'card_events', 'card_deps', 'card_runs'] },
  env: ['REVIEW_DB_URL', 'GH_TOKEN', 'BOARD_URL', 'BOARD_TOKEN', 'ORG_AGENT', 'AGENT_HUB_URL', 'AGENT_HUB_TOKEN'],
  docs: 'docs/kanban-board.md',
});
