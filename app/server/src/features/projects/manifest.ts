import { defineFeature } from '../types.js';

export default defineFeature({
  name: 'projects',
  core: true,
  summary: 'A tracker of areas (what you run) and projects (what you finish): stages, verifications, archive, a kiosk feed and a rendered report',
  nav: [{ section: 'Work', label: 'Projects', path: '/projects' }],
  cli: [
    { command: 'projects', entry: 'cli-projects.js', summary: 'projects: report | list | add | set | verify | archive | unarchive (projects help)' },
    { command: 'areas', entry: 'cli-areas.js', summary: 'areas: list | show | review | report | render | add | set | archive | unarchive | record | team | division | import (areas help)' },
  ],
  timers: [{
    unit: 'secondbrain-projects-render',
    summary: 'renders the markdown report every hour',
    calendar: 'hourly',
    command: 'areas render',
    description: 'Second Brain: render the tracker report into the vault (projects.reportFile in secondbrain.json)',
    timerDescription: 'Second Brain project report render, hourly',
    persistent: true,
    randomizedDelaySec: 120,
    service: { after: ['postgresql.service'], requires: ['postgresql.service'], directives: ['TimeoutStartSec=60'] },
  }, {
    unit: 'secondbrain-areas-review',
    summary: 'writes the weekly review on Sunday evening',
    // @TIMEZONE@ is the vault's `timezone` (secondbrain.json), UTC when unset: the generator fills it in.
    calendar: 'Sun *-*-* 20:00:00 @TIMEZONE@',
    // `ending`, not the current week: a run that was missed and is caught up on Monday still writes the week that ended.
    command: 'areas review --week ending',
    description: 'Second Brain: write the weekly review of areas and projects into the vault (areas.reviewDir in secondbrain.json)',
    timerDescription: 'Second Brain weekly review of areas and projects, Sunday 20:00 in the vault time zone',
    persistent: true,
    randomizedDelaySec: 120,
    service: { after: ['postgresql.service'], requires: ['postgresql.service'], directives: ['TimeoutStartSec=300'] },
  }],
  wrappers: ['cli-projects', 'cli-areas'],
  health: { label: 'the tracker tables answer', tables: ['teams', 'areas', 'projects', 'tracker_events', 'stage_changes', 'kpi_readings', 'verifications'] },
  env: ['PROJECTS_FEED_TOKEN'],
  settings: 'projects',
  docs: 'docs/modules.md#projects',
});
