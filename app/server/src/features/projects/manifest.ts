import { defineFeature } from '../types.js';

export default defineFeature({
  name: 'projects',
  core: true,
  summary: 'A project tracker: projects, features, stages and verifications, with a kiosk feed and a rendered report',
  nav: [{ section: 'Work', label: 'Projects', path: '/projects' }],
  cli: [{ command: 'projects', entry: 'cli-projects.js', summary: 'the tracker: report | list | add | set | verify | render | import (projects help)' }],
  timers: [{
    unit: 'secondbrain-projects-render',
    summary: 'renders the markdown report every hour',
    calendar: 'hourly',
    command: 'projects render',
    description: 'Second Brain: render the project tracker report into the vault (projects.reportFile in secondbrain.json)',
    timerDescription: 'Second Brain project report render, hourly',
    persistent: true,
    randomizedDelaySec: 120,
    service: { after: ['postgresql.service'], requires: ['postgresql.service'], directives: ['TimeoutStartSec=60'] },
  }],
  wrappers: ['cli-projects'],
  health: { label: 'the tracker tables answer', tables: ['teams', 'projects', 'features', 'stage_changes', 'verifications'] },
  env: ['PROJECTS_FEED_TOKEN'],
  settings: 'projects',
  docs: 'docs/modules.md#projects',
});
