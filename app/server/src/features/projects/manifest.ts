import { defineFeature } from '../types.js';

export default defineFeature({
  name: 'projects',
  core: true,
  summary: 'A project tracker: projects, features, stages and verifications, with a kiosk feed and a rendered report',
  nav: [{ section: 'Work', label: 'Projects', path: '/projects' }],
  cli: [{ command: 'projects', entry: 'cli-projects.js', summary: 'the tracker: report | list | add | set | verify | render | import (projects help)' }],
  timers: [{ unit: 'secondbrain-projects-render', summary: 'renders the markdown report every hour' }],
  wrappers: ['cli-projects'],
  env: ['PROJECTS_FEED_TOKEN'],
  settings: 'projects',
  docs: 'docs/modules.md#projects',
});
