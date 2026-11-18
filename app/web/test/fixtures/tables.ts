/**
 * Fake data for every table view in the app, in the shapes the API really returns. Nothing here is a real name,
 * host, address or path. The values are deliberately awkward for a phone: long titles, long model ids, wide rows,
 * and each optional field filled in one row and empty in another. All times sit around 2026-11-10 to 2026-11-14;
 * the browser checks pin the clock to NOW.
 */
import type { BoardCard, BoardInfo, BoardToken } from '@secondbrain/contracts/board';
import type { Stage, TrackerArea, TrackerMarkdownResponse, TrackerProject, TrackerReport } from '@secondbrain/contracts/projects';
import type {
  AgentSessionFacets, AgentSessionRow, AgentSummary, AppMeta, AuthState, CronJob, CronJobDetail, DbQueryResult, DbTable, FileResponse,
  FundOverview, LiveNow, OrgApproval, OrgChart, OrgChartAgent, OrgWakeRow, RingDay, RingNight, RingOverview, RunningNow, Source,
  SummaryOverview, SyncState, SystemdTimer, TreeResponse, UsageConfig, UsageCredits, UsageDimension, UsageFacets, UsageFacetValue, UsagePlan,
  UsageRun, UsageSeriesRow, UsageSubscriptions,
} from '../../src/lib/api.js';

export const NOW = '2026-11-14T12:00:00Z';

const LONG_MODEL = 'provider-x/reasoning-large-preview-2026-10-28-extended-context';
const MODEL = 'model-large-5';
const SMALL_MODEL = 'model-small-5';

// ---- the shell ----

export const auth = { required: false, authenticated: true } satisfies AuthState;

export const meta = {
  modules: ['ring', 'agents', 'projects', 'org', 'board', 'usage', 'summaries', 'fund'],
  nav: [
    { section: 'Work', label: 'Projects', path: '/projects' },
    { section: 'Work', label: 'Org', path: '/org' },
    { section: 'Work', label: 'Board', path: '/board' },
    { section: 'Work', label: 'Usage', path: '/usage' },
  ],
  owner: 'Sam Example',
  devLogPath: null,
  docsPath: null,
  robot: false,
  timezone: 'UTC',
  version: '1.0.0',
  commit: null,
  commitShort: null,
  builtAt: null,
} satisfies AppMeta;

export const syncState = { installed: false } satisfies SyncState;

export const sources = {
  sources: [{
    id: 1, kind: 'vault', name: 'vault', config: {}, enabled: true, created_at: '2026-10-01T08:00:00Z', running: false,
    last_run: { id: 41, source_id: 1, status: 'ok', started_at: '2026-11-14T11:40:00Z', finished_at: '2026-11-14T11:41:00Z', stats: {}, progress: {}, error: null },
  }],
} satisfies { sources: Source[] };

export const tree = {
  path: '',
  dirs: [{ name: 'Areas', path: 'Areas', child_count: 4 }, { name: 'Projects', path: 'Projects', child_count: 7 }],
  files: [{ id: 9, name: 'Reading list.md', path: 'Reading list.md', ext: '.md', is_markdown: true, size_bytes: 2048, mtime: '2026-11-13T09:30:00Z', title: 'Reading list' }],
  total: 3,
  has_more: false,
} satisfies TreeResponse;

/** Open it at FILE_ROUTE. */
export const FILE_PATH = 'Projects/garden-app/Launch plan.md';
export const FILE_ROUTE = '/file/Projects/garden-app/Launch%20plan.md';

export const fileResponse = {
  file: {
    id: 101, name: 'Launch plan.md', path: FILE_PATH, parent_path: 'Projects/garden-app', ext: '.md', is_markdown: true, size_bytes: 5120,
    mtime: '2026-11-13T17:45:00Z', title: 'Launch plan',
    body: [
      '# Launch plan',
      '',
      'What ships in each week, who owns it and how it is checked.',
      '',
      '| Week | Milestone | Owner | Check | Status | Notes |',
      '|---|---|---|---|---|---|',
      '| 46 | Seed catalogue import from the spreadsheet | ada | 400 rows imported, none rejected | done | The importer skips rows without a Latin name and writes them to a review file |',
      '| 47 | Watering reminders on the phone | brook | A reminder fires on two test devices | building | Needs the notification permission prompt reworded |',
      '| 48 | Shared beds between two households | cyd | Both accounts see the same bed within five seconds | designing | Conflict rule: last writer wins, with an undo |',
      '| 49 | Public beta | ada | 25 testers finish onboarding without help | idea | |',
      '',
    ].join('\n'),
  },
  frontmatter: {
    title: 'Launch plan',
    status: 'building',
    owner: 'ada',
    due: '2026-12-05',
    summary: 'The four weeks before the public beta of the garden app: catalogue import, reminders, shared beds, then testers.',
    tags: ['launch', 'garden-app', 'plan'],
    source: 'Projects/garden-app/Meetings/2026-11-10 planning call with the catalogue and reminders owners.md',
    reviewed: true,
  },
  tags: ['launch', 'garden-app', 'plan'],
  links: [],
  backlinks: [{ id: 102, path: 'Projects/garden-app/README.md', title: 'Garden app' }],
} satisfies FileResponse;

// ---- projects ----

const zeroStages = (): Record<Stage, number> => ({ idea: 0, designing: 0, building: 0, testing: 0, live: 0, parked: 0, done: 0 });
const stages = (counts: Partial<Record<Stage, number>>): Record<Stage, number> => ({ ...zeroStages(), ...counts });

const feature = (id: number, slug: string, title: string, stage: Stage, extra: Partial<TrackerProject> = {}): TrackerProject => ({
  id, area: '', slug, title, outcome: null, next_action: null, stage, health: null, owner: null, goals: [], needs_owner: null, blocked_on: null, started: null, due: null, shipped_at: null,
  notes_path: null, archived_at: null, updated_at: '2026-11-12T10:00:00Z', updated_by: null, days_in_stage: 3, last_activity: '2026-11-12T10:00:00Z',
  verification: null, verifications_total: 0, ...extra,
});

/** An area and the projects inside it. `stage` is the old project stage; an area is parked or active. */
const project = (slug: string, title: string, stage: Stage, features: TrackerProject[], extra: Partial<TrackerArea> & { area?: string; due?: string } = {}): TrackerArea => {
  const counts = zeroStages();
  for (const f of features) counts[f.stage] += 1;
  const { area: _home, due: _due, ...rest } = extra;
  return {
    slug, title, team: null, division: null, status: stage === 'parked' ? 'parked' : 'active', health: null, priority: null, goals: [], needs_owner: null, blocked_on: null,
    started: null, devlog_path: null, design_path: null, home_path: null, paths: [], repos: [], archived_at: null, updated_at: '2026-11-13T08:00:00Z', updated_by: null,
    next_action: null, projects: features.map((f) => ({ ...f, area: slug })), counts, progress: features.length ? (counts.live + counts.done) / features.length : null, ...rest,
  };
};

const areas: TrackerArea[] = [
  project('garden-app', 'Garden app for shared household beds', 'building', [
    feature(1, 'seed-catalogue-import', 'Seed catalogue import from the spreadsheet', 'live', {
      health: 'green', owner: 'ada', goals: ['Q4'], started: '2026-10-20', shipped_at: '2026-11-11T15:00:00Z', notes_path: 'Projects/garden-app/Import.md',
      updated_by: 'ada', verification: { kind: 'test', check: '400 rows imported, none rejected', result: 'pass', evidence: 'import log of 2026-11-11', at: '2026-11-11T15:10:00Z', by: 'cyd' }, verifications_total: 2,
    }),
    feature(2, 'watering-reminders-on-the-phone', 'Watering reminders on the phone, with a quiet period at night', 'building', {
      health: 'yellow', owner: 'brook', goals: ['Q4', 'M11'], needs_owner: 'Choose the wording of the notification permission prompt', due: '2026-11-21', started: '2026-11-03',
    }),
    feature(3, 'shared-beds', 'Shared beds between two households', 'designing', { owner: 'cyd', blocked_on: 'The sync rule is not decided', due: '2026-11-28' }),
    feature(4, 'public-beta', 'Public beta', 'idea'),
  ], {
    team: 'product', division: 'apps', area: 'Garden', health: 'yellow', priority: 1, goals: ['Q4'], needs_owner: 'Approve the beta tester list',
    started: '2026-10-01', due: '2026-12-05', devlog_path: 'Projects/garden-app/Dev Log.md', design_path: 'Projects/garden-app/Design.md',
    paths: ['Projects/garden-app'], repos: ['garden-app'], updated_by: 'ada', next_action: 'Finish reminders, then invite ten testers',
  }),
  project('recipe-box-importer', 'Recipe box importer', 'testing', [
    feature(5, 'photo-to-recipe', 'Photo of a handwritten card to a structured recipe', 'testing', { health: 'red', owner: 'ada', due: '2026-11-09', needs_owner: 'Send twenty more sample cards' }),
    feature(6, 'unit-conversion', 'Unit conversion between cups, grams and millilitres', 'live', { shipped_at: '2026-11-08T12:00:00Z', owner: 'brook' }),
  ], { team: 'product', division: 'apps', health: 'red', priority: 2, blocked_on: 'Sample cards', due: '2026-11-30', repos: ['recipe-box'] }),
  project('workshop-signups', 'Workshop sign-up page and waiting list', 'live', [
    feature(7, 'waiting-list', 'Waiting list with an automatic invite when a seat opens', 'live', { shipped_at: '2026-11-12T09:00:00Z', owner: 'cyd' }),
    feature(8, 'reminder-mail', 'Reminder the day before', 'done', { shipped_at: '2026-11-01T09:00:00Z' }),
  ], { team: 'growth', division: 'education', health: 'green', priority: 3 }),
  project('household-budget-sheet', 'Household budget sheet', 'designing', [
    feature(9, 'monthly-rollup', 'Monthly roll-up by category', 'designing', { owner: 'dell' }),
  ], { team: 'growth', division: 'education', priority: 4 }),
  project('reading-notes-archive', 'Reading notes archive with full text search', 'idea', [], { division: 'apps' }),
  project('bike-route-planner', 'Bike route planner', 'parked', [feature(10, 'elevation-profile', 'Elevation profile', 'parked')], { team: 'product' }),
];

const item = (a: string, p: string | null, title: string, detail: string) => ({ area: a, project: p, title, detail });

export const projectsReport = {
  as_of: '2026-11-14T11:30:00Z',
  generated_at: '2026-11-14T11:30:05Z',
  totals: { areas: { active: 5, parked: 1 }, projects: stages({ idea: 1, designing: 2, building: 1, testing: 1, live: 3, parked: 1, done: 1 }) },
  needs_owner: [
    { ...item('garden-app', null, 'Garden app for shared household beds', 'Approve the beta tester list. Twenty-five people replied to the form; eight of them share a household, so decide whether a household counts once or per person before the invites go out on Friday.'), priority: 1, due: '2026-11-15' },
    { ...item('garden-app', 'watering-reminders-on-the-phone', 'Watering reminders on the phone, with a quiet period at night', 'Choose the wording of the notification permission prompt. Two drafts are in the design note. The shorter one tested better with three people but does not mention the quiet period.'), priority: 1, due: '2026-11-21' },
    { ...item('recipe-box-importer', 'photo-to-recipe', 'Photo of a handwritten card to a structured recipe', 'Send twenty more sample cards.'), priority: 2, due: '2026-11-09' },
    { ...item('workshop-signups', 'waiting-list', 'Waiting list with an automatic invite when a seat opens', 'Confirm the room for the December workshop so the seat count can be set; the invite will not send while the count is zero.'), priority: 3, due: null },
    { ...item('household-budget-sheet', null, 'Household budget sheet', 'Pick the categories.'), priority: null, due: '2026-12-01' },
    { ...item('reading-notes-archive', null, 'Reading notes archive with full text search', 'Say whether scanned books are in scope. If they are, the archive needs text recognition first and the estimate doubles.'), priority: null, due: null },
  ],
  divisions: [
    { slug: 'apps', name: 'Apps', areas: ['garden-app', 'recipe-box-importer', 'reading-notes-archive'], in_flight: 2, shipped_7d: 2, needs_owner: 4, statuses: { active: 2, parked: 0 } },
    { slug: 'education', name: 'Education', areas: ['workshop-signups', 'household-budget-sheet'], in_flight: 1, shipped_7d: 1, needs_owner: 2, statuses: { active: 2, parked: 0 } },
  ],
  teams: [
    { slug: 'product', name: 'Product', lead: 'ada', areas: ['garden-app', 'recipe-box-importer', 'bike-route-planner'], in_flight: 2, shipped_7d: 2, needs_owner: 3, statuses: { active: 2, parked: 0 } },
    { slug: 'growth', name: 'Growth', lead: null, areas: ['workshop-signups', 'household-budget-sheet'], in_flight: 1, shipped_7d: 1, needs_owner: 2, statuses: { active: 2, parked: 0 } },
  ],
  goals: [
    { code: 'Y1', horizon: 'year', goal: 'A thousand households keep their garden, recipes and budget in apps they own', due: '2026-12-31', status: 'on track', areas: ['garden-app', 'recipe-box-importer', 'household-budget-sheet'], projects: [] },
    { code: 'Q4', horizon: 'quarter', goal: 'Public beta of the garden app with 25 testers who finish onboarding without help', due: '2026-12-05', status: 'at risk', areas: ['garden-app'], projects: ['garden-app/seed-catalogue-import', 'garden-app/watering-reminders-on-the-phone'] },
    { code: 'M11', horizon: 'month', goal: 'Reminders work on two phones', due: '2026-11-30', status: 'on track', areas: [], projects: ['garden-app/watering-reminders-on-the-phone'] },
    { code: 'M12', horizon: 'month', goal: 'December workshop sold out from the waiting list', due: null, status: 'not started', areas: ['workshop-signups'], projects: ['workshop-signups/waiting-list'] },
    { code: 'W46', horizon: 'week', goal: 'Twenty sample recipe cards read with fewer than two mistakes each', due: '2026-11-15', status: 'behind', areas: ['recipe-box-importer'], projects: ['recipe-box-importer/photo-to-recipe'] },
    { code: 'W47', horizon: 'week', goal: 'Decide the sync rule for shared beds', due: '2026-11-22', status: 'not started', areas: [], projects: [] },
  ],
  gaps: {
    goals_uncovered: [{ code: 'W47', horizon: 'week', goal: 'Decide the sync rule for shared beds', due: '2026-11-22', status: 'not started', areas: [], projects: [] }],
    unverified_shipped: [item('workshop-signups', 'waiting-list', 'Waiting list with an automatic invite when a seat opens', 'live since 2026-11-12, no verification')],
    failing: [item('recipe-box-importer', 'photo-to-recipe', 'Photo of a handwritten card to a structured recipe', 'last check failed on 2026-11-10')],
    testing_unverified: [],
    stale: [item('bike-route-planner', null, 'Bike route planner', 'no activity for 40 days')],
    overdue: [item('recipe-box-importer', 'photo-to-recipe', 'Photo of a handwritten card to a structured recipe', 'due 2026-11-09')],
    no_team: ['reading-notes-archive'], no_division: ['bike-route-planner'], no_projects: ['reading-notes-archive'],
  },
  oldest: [item('garden-app', 'shared-beds', 'Shared beds between two households', 'designing for 21 days')],
  backlog: { total: 9, by_area: [{ area: 'garden-app', count: 5, oldest_days: 12 }, { area: 'recipe-box-importer', count: 4, oldest_days: 30 }] },
  moved_7d: [
    { area: 'garden-app', project: 'seed-catalogue-import', title: 'Seed catalogue import from the spreadsheet', from: 'testing', to: 'live', at: '2026-11-11T15:00:00Z', by: 'ada', note: 'import log attached' },
    { area: 'workshop-signups', project: null, title: 'Workshop sign-up page and waiting list', from: null, to: 'live', at: '2026-11-12T09:00:00Z', by: null, note: null },
  ],
  shipped_7d: [item('garden-app', 'seed-catalogue-import', 'Seed catalogue import from the spreadsheet', 'live'), item('workshop-signups', 'waiting-list', 'Waiting list with an automatic invite when a seat opens', 'live')],
  verified_7d: { pass: 3, fail: 1 },
  areas,
} satisfies TrackerReport;

export const projectsMarkdown = {
  format: 'markdown',
  as_of: '2026-11-14T11:30:00Z',
  text: [
    '# Projects report',
    '',
    'Six projects, two in flight. Three features shipped in the last seven days.',
    '',
    '| Project | Stage | Team | Division | Health | Due | Next action | Needs the owner |',
    '|---|---|---|---|---|---|---|---|',
    '| Garden app for shared household beds | building | product | apps | yellow | 2026-12-05 | Finish reminders, then invite ten testers | Approve the beta tester list |',
    '| Recipe box importer | testing | product | apps | red | 2026-11-30 | Collect sample cards | Send twenty more sample cards |',
    '| Workshop sign-up page and waiting list | live | growth | education | green | | | Confirm the room for the December workshop |',
    '| Household budget sheet | designing | growth | education | | 2026-12-01 | | Pick the categories |',
    '| Reading notes archive with full text search | idea | | apps | | | | Say whether scanned books are in scope |',
    '| Bike route planner | parked | product | | | | | |',
    '',
  ].join('\n'),
} satisfies TrackerMarkdownResponse;

// ---- board ----

export const boardBoards = {
  boards: [
    { slug: 'main', name: 'Main', team_slug: null, created_at: '2026-10-01T08:00:00Z', open: 11 },
    { slug: 'product', name: 'Product', team_slug: 'product', created_at: '2026-10-02T08:00:00Z', open: 4 },
  ],
} satisfies { boards: BoardInfo[] };

const card = (id: string, title: string, status: BoardCard['status'], extra: Partial<BoardCard> = {}): BoardCard => ({
  id, board_slug: 'main', title, body: null, contract: {}, status, priority: 2, assignee: null, created_by: 'owner', area_slug: null, project_slug: null,
  kind: 'task', work_type: null, needs: null, ship_now: false, repo: null, graph: null, node: null, rounds: 0, scheduled_for: null, block_kind: null,
  block_reason: null, result: null, created_at: '2026-11-12T09:00:00Z', started_at: null, completed_at: null, updated_at: '2026-11-13T09:00:00Z', ...extra,
});

export const boardCards = {
  cards: [
    card('t_0a11', 'Sort the inbox of testers who replied to the beta form and mark shared households', 'triage', { priority: 1, created_by: 'ada' }),
    card('t_0a12', 'Idea: export a bed as a printable planting plan', 'triage', { kind: 'idea' }),
    card('t_0b21', 'Write the two drafts of the notification permission prompt', 'todo', { assignee: 'brook', area_slug: 'garden-app', project_slug: 'watering-reminders-on-the-phone', work_type: 'design', priority: 1 }),
    card('t_0b22', 'Collect twenty more handwritten sample cards', 'todo', { assignee: 'ada', area_slug: 'recipe-box-importer', project_slug: 'photo-to-recipe', needs: 'owner' }),
    card('t_0c31', 'Send the workshop reminder', 'scheduled', { assignee: 'cyd', area_slug: 'workshop-signups', scheduled_for: '2026-11-20T08:00:00Z', kind: 'routine' }),
    card('t_0d41', 'Quiet period at night for reminders, with the hours in settings', 'ready', { assignee: 'brook', area_slug: 'garden-app', project_slug: 'watering-reminders-on-the-phone', work_type: 'build', repo: 'garden-app', contract: { objective: 'No reminder fires between 22:00 and 07:00 local time', verification: 'unit test on the scheduler', budget: { turns: 40, minutes: 30 } } }),
    card('t_0d42', 'Fix the unit conversion rounding for teaspoons', 'ready', { assignee: 'ada', area_slug: 'recipe-box-importer', project_slug: 'unit-conversion', work_type: 'fix', priority: 3 }),
    card('t_0e51', 'Reminder scheduler: one row per bed and day, idempotent on retry', 'running', { assignee: 'brook', area_slug: 'garden-app', project_slug: 'watering-reminders-on-the-phone', work_type: 'build', repo: 'garden-app', rounds: 2, started_at: '2026-11-14T11:20:00Z', ship_now: true }),
    card('t_0e52', 'Research: how other planners handle two writers on one bed', 'running', { assignee: 'cyd', area_slug: 'garden-app', project_slug: 'shared-beds', work_type: 'research', started_at: '2026-11-14T10:05:00Z' }),
    card('t_0f61', 'Seed catalogue import: write rejected rows to a review file', 'review', { assignee: 'ada', area_slug: 'garden-app', project_slug: 'seed-catalogue-import', work_type: 'build', repo: 'garden-app', rounds: 1, result: 'Branch pushed; 14 tests pass; needs approve.' }),
    card('t_0g71', 'Photo to recipe: accuracy on cursive handwriting', 'blocked', { assignee: 'ada', area_slug: 'recipe-box-importer', project_slug: 'photo-to-recipe', block_kind: 'needs-owner', block_reason: 'Only six cursive samples exist; twenty are needed for a meaningful number.' }),
    card('t_0g72', 'Shared beds: decide the sync rule', 'blocked', { area_slug: 'garden-app', project_slug: 'shared-beds', block_kind: 'decision', block_reason: 'Waiting for the research card', priority: 1 }),
    card('t_0h81', 'Waiting list invite when a seat opens', 'done', { assignee: 'cyd', area_slug: 'workshop-signups', project_slug: 'waiting-list', completed_at: '2026-11-12T09:00:00Z', result: 'Shipped and checked on a test seat.' }),
    card('t_0h82', 'Monthly roll-up sketch', 'done', { assignee: 'dell', area_slug: 'household-budget-sheet', completed_at: '2026-11-10T16:00:00Z' }),
    card('t_0i91', 'Old elevation profile spike', 'archived', { area_slug: 'bike-route-planner', completed_at: '2026-10-05T16:00:00Z' }),
  ],
} satisfies { cards: BoardCard[] };

export const boardTokens = {
  tokens: [
    { id: 1, agent_name: 'ada', label: 'laptop, the kitchen one', created_at: '2026-10-03T08:12:44Z', last_seen_at: '2026-11-14T11:58:03Z', revoked_at: null },
    { id: 2, agent_name: 'brook', label: 'server-a dispatcher process for the product lane', created_at: '2026-10-09T19:40:10Z', last_seen_at: '2026-11-14T11:59:41Z', revoked_at: null },
    { id: 3, agent_name: 'cyd', label: null, created_at: '2026-10-21T07:00:00Z', last_seen_at: null, revoked_at: null },
    { id: 4, agent_name: 'dell', label: 'old tablet', created_at: '2026-09-15T12:30:00Z', last_seen_at: '2026-10-02T22:15:09Z', revoked_at: '2026-10-05T09:00:00Z' },
    { id: 5, agent_name: 'ada', label: 'server-b', created_at: '2026-11-11T10:00:00Z', last_seen_at: '2026-11-13T03:20:00Z', revoked_at: null },
  ],
} satisfies { tokens: BoardToken[] };

// ---- org ----

const agent = (name: string, team: string, teamName: string, role: string, extra: Partial<OrgChartAgent> = {}): OrgChartAgent => ({
  name, team_slug: team, team_name: teamName, runtime: 'claude-code', role, reports_to: null, model: MODEL, expertise: null, avatar: null, is_lead: false,
  session_id: null, session_started: null, activity: null, caps: null, ...extra,
});

export const orgChart = {
  teams: [{ slug: 'product', name: 'Product', lead: 'ada' }, { slug: 'growth', name: 'Growth', lead: 'dell' }],
  agents: [
    agent('ada', 'product', 'Product', 'Head of Product', { is_lead: true, expertise: 'catalogues, imports, release planning', activity: { last_wake: '2026-11-14T11:20:00Z', wakes_today: 4, open_wakeups: 1, unread: 2, last_post: '2026-11-14T11:25:00Z' }, caps: { wakes_per_day: 12, cooldown_minutes: 10, max_runtime_minutes: 30, lane: 'product', routines: [{ name: 'standup', at: '08:00' }] } }),
    agent('brook', 'product', 'Product', 'Mobile engineer', { reports_to: 'ada', runtime: 'zen-agent', model: LONG_MODEL }),
    agent('cyd', 'product', 'Product', 'Researcher', { reports_to: 'ada', model: null }),
    agent('dell', 'growth', 'Growth', 'Head of Growth', { is_lead: true }),
  ],
} satisfies OrgChart;

export const orgApprovals = [
  { id: 1, task_id: 't_0f61', pr_url: 'https://git.example/garden-app/pull/41', deploy_target: 'staging', summary: 'Seed catalogue import: rejected rows go to a review file instead of being dropped', requested_by: 'ada', status: 'pending', ship_now: false, decided_by: null, decided_at: null, note: null, created_at: '2026-11-14T09:10:00Z' },
  { id: 2, task_id: 't_0e51', pr_url: null, deploy_target: null, summary: 'Reminder scheduler', requested_by: 'brook', status: 'pending', ship_now: true, decided_by: null, decided_at: null, note: null, created_at: '2026-11-14T11:30:00Z' },
  { id: 3, task_id: 't_0h81', pr_url: 'https://git.example/workshop/pull/7', deploy_target: 'production', summary: 'Waiting list invite when a seat opens', requested_by: 'cyd', status: 'approved', ship_now: false, decided_by: 'owner', decided_at: '2026-11-12T08:50:00Z', note: 'Checked on a test seat', created_at: '2026-11-12T08:00:00Z' },
] satisfies OrgApproval[];

// ---- database ----

export const dbSchema = {
  tables: [
    { name: 'files', kind: 'table', rows: 18452, note: 'One row per file in the vault, markdown or not.', columns: [
      { name: 'id', type: 'bigint', nullable: false, default: "nextval('files_id_seq'::regclass)", generated: false, pk: true, references: null },
      { name: 'path', type: 'text', nullable: false, default: null, generated: false, pk: false, references: null },
      { name: 'parent_path', type: 'text', nullable: false, default: null, generated: true, pk: false, references: null },
      { name: 'title', type: 'text', nullable: true, default: null, generated: false, pk: false, references: null },
      { name: 'size_bytes', type: 'bigint', nullable: false, default: '0', generated: false, pk: false, references: null },
      { name: 'mtime', type: 'timestamp with time zone', nullable: false, default: null, generated: false, pk: false, references: null },
      { name: 'frontmatter', type: 'jsonb', nullable: true, default: null, generated: false, pk: false, references: null },
    ] },
    { name: 'links', kind: 'table', rows: 60231, note: null, columns: [
      { name: 'id', type: 'bigint', nullable: false, default: null, generated: false, pk: true, references: null },
      { name: 'source_file_id', type: 'bigint', nullable: false, default: null, generated: false, pk: false, references: { table: 'files', column: 'id' } },
      { name: 'target_file_id', type: 'bigint', nullable: true, default: null, generated: false, pk: false, references: { table: 'files', column: 'id' } },
      { name: 'target_raw', type: 'text', nullable: false, default: null, generated: false, pk: false, references: null },
      { name: 'alias', type: 'text', nullable: true, default: null, generated: false, pk: false, references: null },
      { name: 'created_at', type: 'timestamp with time zone', nullable: false, default: 'now()', generated: false, pk: false, references: null },
    ] },
    { name: 'usage_runs_with_labels', kind: 'view', rows: null, note: 'Each headless run joined to its card, project and feature labels.', columns: [
      { name: 'run_id', type: 'text', nullable: false, default: null, generated: false, pk: false, references: null },
      { name: 'agent_name', type: 'text', nullable: true, default: null, generated: false, pk: false, references: null },
      { name: 'area_slug', type: 'text', nullable: true, default: null, generated: false, pk: false, references: null },
      { name: 'project_slug', type: 'text', nullable: true, default: null, generated: false, pk: false, references: null },
      { name: 'started_at', type: 'timestamp with time zone', nullable: true, default: null, generated: false, pk: false, references: null },
      { name: 'duration_ms', type: 'integer', nullable: true, default: null, generated: false, pk: false, references: null },
      { name: 'output_tokens', type: 'bigint', nullable: true, default: null, generated: false, pk: false, references: null },
    ] },
  ],
} satisfies { tables: DbTable[] };

export const dbQueryResult = {
  columns: ['id', 'path', 'title', 'size_bytes', 'mtime', 'frontmatter', 'summary', 'archived_at'],
  rows: [
    [101, 'Projects/garden-app/Launch plan.md', 'Launch plan', 5120, '2026-11-13T17:45:00Z', { status: 'building', owner: 'ada', tags: ['launch', 'plan'] }, 'The four weeks before the public beta of the garden app: catalogue import, reminders, shared beds, then testers. Each week has one owner and one check that can be run by somebody else.', null],
    [102, 'Projects/garden-app/README.md', 'Garden app', 1890, '2026-11-12T08:02:11Z', { status: 'building' }, 'What the garden app is and who it is for.', null],
    [103, 'Projects/recipe-box-importer/Samples/handwritten-cards-batch-02-cursive-and-print-mixed.md', null, 20480, '2026-11-10T21:14:00Z', null, null, null],
    [104, 'Areas/household/Budget 2026.md', 'Budget 2026', 73211, '2026-11-14T07:30:45Z', { reviewed: true, categories: 14 }, 'Monthly roll-up by category with the three accounts side by side, and a note for every month where a category moved by more than a fifth.', null],
    [105, 'Archive/2025/Bike routes.md', 'Bike routes', 0, '2025-08-02T10:00:00Z', {}, '', '2026-10-05T16:00:00Z'],
    [106, 'Reading list.md', 'Reading list', 2048, '2026-11-13T09:30:00Z', { tags: [] }, 'Books and papers, newest first.', null],
  ],
  row_count: 6,
  truncated: false,
  ms: 12,
} satisfies DbQueryResult;

// ---- cron ----

/** Open the detail at CRON_JOB_ROUTE. */
export const CRON_JOB_ROUTE = '/cron/main/daily-garden-digest';

const cronJob = (job_id: string, name: string, extra: Partial<CronJob> = {}): CronJob => ({
  profile: 'main', job_id, name, schedule: '0 7 * * *', state: 'scheduled', enabled: true, next_run_at: '2026-11-15T07:00:00Z', last_run_at: '2026-11-14T07:00:00Z',
  last_status: 'ok', last_error: null, deliver: null, skill: null, timezone: 'UTC', removed_at: null, runs: 12, outputs: 12, ...extra,
});

const digestJob = cronJob('daily-garden-digest', 'Daily garden digest with watering plan, frost warnings and the list of beds to check', {
  schedule: '0 7,19 * * 1-5 (weekdays at 07:00 and 19:00)', deliver: 'telegram', skill: 'garden-digest', script: 'scripts/collect-weather.sh',
  prompt: 'Read the bed notes changed since the last run and the weather for the next three days. Write a digest with: what to water today and how much, any bed with a frost warning, seedlings that are due to be moved, and one line on what changed since yesterday. Keep it under 200 words. If nothing changed, say so in one sentence.',
  runs: 46, outputs: 44,
});

export const cronJobs = {
  jobs: [
    digestJob,
    cronJob('weekly-budget-rollup', 'Weekly budget roll-up', { schedule: '30 18 * * 0', timezone: 'Europe/Lisbon', next_run_at: '2026-11-15T18:30:00Z', last_run_at: '2026-11-08T18:30:00Z', skill: 'budget-rollup', runs: 6, outputs: 6 }),
    cronJob('recipe-inbox-sweep', 'Recipe inbox sweep', { profile: 'kitchen', schedule: 'every 6h', state: 'paused', enabled: false, next_run_at: null, last_status: 'error', last_error: 'The inbox folder was not found', runs: 30, outputs: 21 }),
    cronJob('workshop-reminder', 'Workshop reminder the day before', { schedule: '2026-11-20T08:00:00Z', state: 'scheduled', last_run_at: null, last_status: null, deliver: 'origin', runs: 0, outputs: 0 }),
    cronJob('reading-list-digest', 'Reading list digest', { profile: 'kitchen', schedule: null, state: 'completed', enabled: false, next_run_at: null, timezone: null, runs: 1, outputs: 1 }),
    cronJob('old-bike-route-check', 'Old bike route check', { schedule: '0 6 * * 6', state: null, enabled: false, next_run_at: null, last_run_at: '2026-10-03T06:00:00Z', removed_at: '2026-10-05T16:00:00Z', runs: undefined, outputs: undefined }),
  ],
  last_sync: { ran_at: '2026-11-14T11:45:00Z', host: 'server-a' },
} satisfies { jobs: CronJob[]; last_sync: { ran_at: string; host: string } | null };

export const cronTimers = {
  available: true,
  timers: [
    { unit: 'secondbrain-scan.timer', activates: 'secondbrain-scan.service', next: '2026-11-14T12:15:00Z', last: '2026-11-14T11:45:00Z' },
    { unit: 'secondbrain-agents-sync.timer', activates: 'secondbrain-agents-sync.service', next: '2026-11-14T12:05:00Z', last: '2026-11-14T11:55:00Z' },
    { unit: 'secondbrain-usage-collect-subscriptions.timer', activates: 'secondbrain-usage-collect-subscriptions.service', next: '2026-11-14T12:01:00Z', last: '2026-11-14T11:46:00Z' },
    { unit: 'secondbrain-backup.timer', activates: 'secondbrain-backup.service', next: null, last: null },
  ],
} satisfies { available: boolean; timers: SystemdTimer[] };

export const cronJobDetail = {
  job: digestJob,
  runs: [
    { id: 'r6', status: 'completed', claimed_at: '2026-11-14T07:00:00Z', started_at: '2026-11-14T07:00:02Z', finished_at: '2026-11-14T07:01:14Z', error: null },
    { id: 'r5', status: 'completed', claimed_at: '2026-11-13T19:00:00Z', started_at: '2026-11-13T19:00:01Z', finished_at: '2026-11-13T19:00:58Z', error: null },
    { id: 'r4', status: 'failed', claimed_at: '2026-11-13T07:00:00Z', started_at: '2026-11-13T07:00:03Z', finished_at: '2026-11-13T07:05:03Z', error: 'The weather script timed out after 300 seconds and the digest was not written' },
    { id: 'r3', status: 'completed', claimed_at: '2026-11-12T19:00:00Z', started_at: '2026-11-12T19:00:02Z', finished_at: '2026-11-12T19:01:40Z', error: null },
    { id: 'r2', status: 'running', claimed_at: '2026-11-12T07:00:00Z', started_at: '2026-11-12T07:00:02Z', finished_at: null, error: null },
    { id: 'r1', status: 'claimed', claimed_at: '2026-11-11T19:00:00Z', started_at: null, finished_at: null, error: null },
  ],
  outputs: [
    { file_name: '2026-11-14_07-01-14.md', run_at: '2026-11-14T07:01:14Z', chars: 812, preview: 'Water beds 2 and 5 today, about four litres each. Frost is forecast for Sunday night: cover the lettuce.' },
    { file_name: '2026-11-13_19-00-58.md', run_at: '2026-11-13T19:00:58Z', chars: 301, preview: 'Nothing changed since this morning.' },
  ],
  sessions: [
    { id: 501, external_id: 'cron_daily-garden-digest_20261114_070002', started_at: '2026-11-14T07:00:02Z', message_count: 14 },
    { id: 500, external_id: 'cron_daily-garden-digest_20261113_190001', started_at: '2026-11-13T19:00:01Z', message_count: 9 },
    { id: 499, external_id: 'cron_daily-garden-digest_20261113_070003', started_at: '2026-11-13T07:00:03Z', message_count: 31 },
  ],
} satisfies CronJobDetail;

// ---- usage ----

export const usageConfig = { subscriptions: ['claude-code'], credits: ['openrouter'], sections: ['running', 'ledger', 'sessions', 'summaries'] } satisfies UsageConfig;

export const usagePlan = {
  current: {
    five_hour: { used_pct: 42, left_pct: 58, resets_at: '2026-11-14T15:00:00Z', observed_at: '2026-11-14T11:55:00Z', host: 'server-a', origin: 'statusline', reset_since_reading: false, last_pct: 42 },
    seven_day: null,
  },
  history: [
    { observed_at: '2026-11-13T14:00:00Z', window: 'five_hour', used_pct: 12 },
    { observed_at: '2026-11-13T20:00:00Z', window: 'five_hour', used_pct: 64 },
    { observed_at: '2026-11-14T08:00:00Z', window: 'five_hour', used_pct: 20 },
    { observed_at: '2026-11-14T11:55:00Z', window: 'five_hour', used_pct: 42 },
    { observed_at: '2026-11-13T14:00:00Z', window: 'seven_day', used_pct: 31 },
    { observed_at: '2026-11-14T11:55:00Z', window: 'seven_day', used_pct: 37 },
  ],
} satisfies UsagePlan;

const seriesRows: UsageSeriesRow[] = [];
for (let h = 0; h < 24; h += 3) {
  const bucket = new Date(Date.parse('2026-11-13T12:00:00Z') + h * 3600_000).toISOString();
  seriesRows.push({ bucket, key: MODEL, input: 12_000 + h * 900, cache_write: 40_000 + h * 1500, cache_read: 310_000 + h * 22_000, output: 9_000 + h * 400, calls: 20 + h });
  seriesRows.push({ bucket, key: LONG_MODEL, input: 3_000 + h * 100, cache_write: 0, cache_read: 44_000 + h * 3000, output: 2_500 + h * 90, calls: 6 + (h % 5) });
}
export const usageSeries = { bucket: 'hour', tz: 'UTC', rows: seriesRows } satisfies { bucket: string; tz: string; rows: UsageSeriesRow[] };

const facet = (value: string, calls: number, tokens: number, output: number): UsageFacetValue => ({ value, calls, tokens, output });
const facets: Record<UsageDimension, UsageFacetValue[]> = {
  agent: [facet('ada', 212, 4_810_000, 96_400), facet('brook', 148, 3_120_500, 71_250), facet('cyd', 61, 902_300, 18_900), facet('dell', 12, 88_000, 3_100), facet('unlabelled', 44, 1_250_000, 30_500)],
  team: [facet('product', 421, 8_832_800, 186_550), facet('growth', 12, 88_000, 3_100)],
  job: [facet('morning-briefing', 14, 310_000, 6_200), facet('unlabelled', 419, 8_610_800, 183_450)],
  reason: [facet('task', 260, 6_100_000, 120_000), facet('routine', 90, 1_400_000, 30_000), facet('mention', 50, 900_000, 20_000), facet('dm', 33, 520_800, 19_650)],
  action: [facet('edit', 180, 3_900_000, 80_000), facet('read', 150, 3_000_000, 40_000), facet('post', 60, 700_000, 30_000)],
  work_type: [facet('build', 240, 5_600_000, 110_000), facet('research', 61, 902_300, 18_900), facet('design', 40, 800_000, 20_000), facet('fix', 22, 410_000, 9_000)],
  area: [facet('garden-app', 320, 7_100_000, 150_000), facet('recipe-box-importer', 70, 1_300_000, 26_000), facet('workshop-signups', 31, 432_800, 10_550)],
  project: [facet('watering-reminders-on-the-phone', 190, 4_400_000, 92_000), facet('seed-catalogue-import', 90, 1_900_000, 40_000), facet('shared-beds', 40, 800_000, 18_000)],
  task: [facet('t_0e51', 120, 2_800_000, 61_000), facet('t_0f61', 90, 1_900_000, 40_000), facet('t_0e52', 61, 902_300, 18_900)],
  host: [facet('server-a', 380, 8_000_000, 170_000), facet('laptop', 97, 2_170_800, 50_150)],
  headless: [facet('true', 433, 8_920_800, 189_650), facet('false', 44, 1_250_000, 30_500)],
  surface: [facet('cli', 400, 9_000_000, 200_000), facet('telegram', 77, 1_170_800, 20_150)],
  lane: [facet('product', 300, 6_900_000, 140_000), facet('growth', 12, 88_000, 3_100)],
  model: [facet(MODEL, 301, 7_420_000, 151_300), facet(LONG_MODEL, 118, 1_904_800, 48_200), facet(SMALL_MODEL, 46, 720_000, 17_050), facet('local/tiny-instruct-q4', 9, 96_000, 3_400), facet('unlabelled', 3, 30_000, 200)],
  provider: [facet('subscription', 347, 8_140_000, 168_350), facet('provider-x', 118, 1_904_800, 48_200), facet('local', 12, 126_000, 3_600)],
  source: [facet('claude-code', 347, 8_140_000, 168_350), facet('zen-agent', 130, 2_030_800, 51_800)],
};
export const usageFacets = { from: '2026-11-13T12:00:00Z', to: '2026-11-14T12:00:00Z', total: { calls: 477, tokens: 10_170_800 }, facets } satisfies UsageFacets;

const run = (session_id: string, extra: Partial<UsageRun> = {}): UsageRun => ({
  host: 'server-a', session_id, task_id: null, lane: null, board: null, model: MODEL, started_at: null, ended_at: null, duration_ms: null, num_turns: null,
  subtype: null, is_error: null, verify_name: null, verify_passed: null, verify_exit: null, verify_metric: null, verify_output: null, ...extra,
});

export const usageRuns = {
  runs: [
    run('5b0c7a52-1111-4a6e-9c11-000000000001', {
      run_id: 'run-0e51-2', task_id: 't_0e51', lane: 'product', board: 'main', started_at: '2026-11-14T11:20:00Z', ended_at: '2026-11-14T11:41:30Z', duration_ms: 1_290_000, num_turns: 38,
      subtype: 'success', is_error: false, verify_name: 'npm test', verify_passed: true, verify_exit: 0, verify_metric: 195, verify_output: '195 passed', agent_name: 'brook', team_slug: 'product',
      reason: 'task', reasons: [{ reason: 'task', ref: 't_0e51' }], work_type: 'build', area_slug: 'garden-app', project_slug: 'watering-reminders-on-the-phone',
      card_title: 'Reminder scheduler: one row per bed and day, idempotent on retry', resumed: true, surface: 'cli', calls: 52, input: 18_200, cache_write: 96_000, cache_read: 1_840_000, output: 31_400,
      runtime: 'zen-agent', source: 'zen-agent', tier: 'large', outcome: 'done', cost_usd: 1.2345, compactions: 1, blocked: 0,
    }),
    run('5b0c7a52-2222-4a6e-9c11-000000000002', {
      run_id: 'run-0f61-1', task_id: 't_0f61', board: 'main', started_at: '2026-11-14T09:02:00Z', ended_at: '2026-11-14T09:10:00Z', duration_ms: 480_000, num_turns: 21, subtype: 'success', is_error: false,
      verify_name: 'import fixture check with the rejected rows file', verify_passed: false, verify_exit: 1, verify_metric: null, verify_output: '2 rows missing', agent_name: 'ada', team_slug: 'product',
      reason: 'task', work_type: 'build', area_slug: 'garden-app', project_slug: 'seed-catalogue-import', card_title: 'Seed catalogue import: write rejected rows to a review file',
      calls: 30, input: 9_100, cache_write: 41_000, cache_read: 720_000, output: 12_800, runtime: 'claude-code', source: 'claude-code',
    }),
    run('5b0c7a52-3333-4a6e-9c11-000000000003', {
      run_id: 'run-mention-7', started_at: '2026-11-14T08:15:00Z', ended_at: '2026-11-14T08:16:10Z', duration_ms: 70_000, num_turns: 3, agent_name: 'cyd', team_slug: 'product',
      reason: 'mention', calls: 4, input: 1_200, cache_write: 0, cache_read: 38_000, output: 640, runtime: 'claude-code',
    }),
    run('5b0c7a52-4444-4a6e-9c11-000000000004', {
      lane: 'growth', task_id: 't_0h82', started_at: '2026-11-13T16:40:00Z', ended_at: '2026-11-13T16:58:00Z', duration_ms: 1_080_000, num_turns: 17, work_type: 'design',
      area_slug: 'household-budget-sheet', card_title: 'Monthly roll-up sketch', model: LONG_MODEL, calls: 19, input: 4_000, cache_write: 12_000, cache_read: 260_000, output: 8_900, runtime: 'zen-agent', tier: null, cost_usd: 0.0412,
    }),
    run('5b0c7a52-5555-4a6e-9c11-000000000005', { host: 'laptop', run_id: 'run-routine-standup', started_at: '2026-11-14T08:00:00Z', agent_name: 'dell', team_slug: 'growth', reason: 'routine', calls: null }),
    run('5b0c7a52-6666-4a6e-9c11-000000000006'),
  ],
} satisfies { runs: UsageRun[] };

export const usageOrgWakes = {
  agents: [
    { agent_name: 'ada', team_slug: 'product', role: 'Head of Product', wakes: 14, done: 12, open: 2, routine: 3, dm: 2, mention: 4, task: 5, tokens: 4_810_000, output: 96_400, avg_minutes: 11.4, last_wake: '2026-11-14T11:20:00Z' },
    { agent_name: 'brook', team_slug: 'product', role: 'Mobile engineer', wakes: 9, done: 9, open: 0, routine: 1, dm: 0, mention: 1, task: 7, tokens: 3_120_500, output: 71_250, avg_minutes: 18.2, last_wake: '2026-11-14T11:41:00Z' },
    { agent_name: 'cyd', team_slug: 'product', role: 'Researcher', wakes: 5, done: 4, open: 1, routine: 1, dm: 1, mention: 2, task: 1, tokens: 902_300, output: 18_900, avg_minutes: 6, last_wake: '2026-11-14T10:05:00Z' },
    { agent_name: 'dell', team_slug: 'growth', role: 'Head of Growth', wakes: 2, done: 2, open: 0, routine: 2, tokens: 88_000, output: 3_100, avg_minutes: 2.5, last_wake: '2026-11-14T08:00:00Z' },
    { agent_name: 'eno', team_slug: null, role: 'Reviewer and release gate for every engineering card', wakes: 1, done: 0, open: 1, routine: 0, dm: 0, mention: 0, task: 1, avg_minutes: null, last_wake: '2026-11-13T22:10:00Z' },
    { agent_name: 'fern', team_slug: 'growth', role: 'Writer', wakes: 0, done: 0, open: 0, routine: 0, avg_minutes: null, last_wake: null },
  ],
} satisfies { agents: OrgWakeRow[] };

export const usageCredits = {
  providers: [{
    provider: 'openrouter',
    latest: { provider: 'openrouter', origin: 'api', status: 'ok', observed_at: '2026-11-14T11:45:00Z', balance: 18.42, total_credits: 50, total_usage: 31.58, currency: 'USD', error: null, note: null },
    last_ok: { provider: 'openrouter', origin: 'api', status: 'ok', observed_at: '2026-11-14T11:45:00Z', balance: 18.42, total_credits: 50, total_usage: 31.58, currency: 'USD', error: null, note: null },
  }],
  history: [
    { provider: 'openrouter', observed_at: '2026-11-10T11:45:00Z', balance: 24.1, currency: 'USD' },
    { provider: 'openrouter', observed_at: '2026-11-14T11:45:00Z', balance: 18.42, currency: 'USD' },
  ],
} satisfies UsageCredits;

export const usageSubscriptions = {
  providers: [{
    provider: 'claude-code', label: 'Claude Code', status: 'ok', observed_at: '2026-11-14T11:55:00Z', source: 'statusline on server-a', message: null, stale: false,
    windows: [
      { key: 'five_hour', label: '5 hour window', window_minutes: 300, used_pct: 42, left_pct: 58, resets_at: '2026-11-14T15:00:00Z', observed_at: '2026-11-14T11:55:00Z', reset_since_reading: false, last_pct: 42 },
      { key: 'seven_day', label: '7 day window', window_minutes: 10080, used_pct: 37, left_pct: 63, resets_at: '2026-11-18T09:00:00Z', observed_at: '2026-11-14T11:55:00Z', reset_since_reading: false, last_pct: 37 },
    ],
  }],
} satisfies UsageSubscriptions;

const session = (id: number, external_id: string, extra: Partial<AgentSessionRow> = {}): AgentSessionRow => ({
  id, source: 'claude-code', harness: 'claude-code', profile: null, provider: null, host: 'server-a', external_id, parent_external_id: null, project: null,
  title: null, first_prompt: null, channel: null, channel_bot: null, started_at: null, ended_at: null, steps: 0, tool_calls: 0, errors: 0, subagents: 0,
  models: [], calls: 0, input: 0, cache_write: 0, cache_read: 0, output: 0, reasoning: 0, ...extra,
});

export const agentSessions = {
  sessions: [
    session(901, '7f3a1c9e-0001-4b7d-8f21-aaaaaaaa0001', {
      task_ids: ['t_0e51', 't_0d41'], project: 'garden-app', title: 'Reminder scheduler', first_prompt: 'Card t_0e51', session_type: 'headless', persona: 'brook',
      display_title: 'Reminder scheduler: one row per bed and day, idempotent on retry, with a quiet period at night', title_source: 'task',
      context_tokens: 148_200, context_at: '2026-11-14T11:41:00Z', context_window: 200_000, started_at: '2026-11-14T11:20:00Z', ended_at: '2026-11-14T11:41:30Z',
      steps: 214, tool_calls: 96, errors: 3, subagents: 2, models: [MODEL, SMALL_MODEL], calls: 52, input: 18_200, cache_write: 96_000, cache_read: 1_840_000, output: 31_400, reasoning: 9_800,
    }),
    session(902, '7f3a1c9e-0002-4b7d-8f21-aaaaaaaa0002', {
      source: 'hermes', harness: 'hermes', profile: 'kitchen', provider: 'provider-x', host: 'laptop', channel: 'telegram', channel_bot: 'kitchen-bot', session_type: 'telegram', persona: 'ada',
      display_title: 'daily-update', title_source: 'skill', context_tokens: 22_000, context_window: null, started_at: '2026-11-14T07:13:00Z', ended_at: '2026-11-14T07:15:40Z',
      steps: 31, tool_calls: 11, models: [LONG_MODEL], calls: 9, input: 6_100, cache_read: 40_500, output: 2_950, cost_usd: 0.08,
    }),
    session(903, '7f3a1c9e-0003-4b7d-8f21-aaaaaaaa0003', {
      parent_external_id: '7f3a1c9e-0001-4b7d-8f21-aaaaaaaa0001', session_type: 'headless', persona: 'brook', display_title: 'Find every caller of scheduleReminder and list the retry paths',
      title_source: 'prompt', started_at: '2026-11-14T11:24:00Z', ended_at: '2026-11-14T11:26:10Z', steps: 40, tool_calls: 22, models: [SMALL_MODEL], calls: 12, input: 2_400, cache_read: 210_000, output: 3_300,
    }),
    session(904, '7f3a1c9e-0004-4b7d-8f21-aaaaaaaa0004', {
      source: 'zen-agent', harness: 'zen-agent', profile: 'main', provider: 'local', channel: 'web', session_type: 'web', persona: 'cyd', project: 'garden-app',
      display_title: 'Research: how other planners handle two writers on one bed', title_source: 'title', context_tokens: 61_000, context_window: 128_000,
      started_at: '2026-11-14T10:05:00Z', ended_at: '2026-11-14T10:52:00Z', steps: 88, tool_calls: 41, errors: 1, models: ['local/tiny-instruct-q4'], calls: 30, input: 51_000, output: 12_700, cost_usd: 0,
    }),
    session(905, '7f3a1c9e-0005-4b7d-8f21-aaaaaaaa0005', { host: 'laptop', session_type: 'cli', started_at: '2026-11-13T21:02:00Z', steps: 6, tool_calls: 2, models: [MODEL], calls: 3, input: 900, cache_read: 12_000, output: 410 }),
    session(906, '7f3a1c9e-0006-4b7d-8f21-aaaaaaaa0006', { session_type: 'unknown' }),
    session(907, '7f3a1c9e-0007-4b7d-8f21-aaaaaaaa0007', {
      source: 'codex', harness: 'codex', provider: 'provider-y', host: 'server-b', channel: 'remote-control', channel_bot: 'ada', persona: 'ada', session_type: 'remote-control', task_ids: ['t_0f61'],
      display_title: 'Seed catalogue import: write rejected rows to a review file', title_source: 'task', context_tokens: 9_000, context_window: 400_000,
      started_at: '2026-11-14T09:02:00Z', ended_at: '2026-11-14T09:10:00Z', steps: 120, tool_calls: 58, errors: 12, subagents: 1, models: ['codex-large-2026-10', LONG_MODEL], calls: 30, input: 9_100, cache_write: 41_000, cache_read: 720_000, output: 12_800, reasoning: 30_100, cost_usd: 2.5,
    }),
    session(908, '7f3a1c9e-0008-4b7d-8f21-aaaaaaaa0008', {
      host: 'server-a', session_type: 'headless', persona: 'dell', display_title: 'Standup', title_source: 'title', started_at: '2026-11-14T08:00:00Z', ended_at: '2026-11-14T08:00:50Z',
      steps: 9, tool_calls: 4, models: [MODEL], calls: 2, input: 700, cache_read: 30_000, output: 380,
    }),
  ],
  total: 8,
} satisfies { sessions: AgentSessionRow[]; total: number };

export const agentSessionFacets = {
  facets: {
    harness: [{ value: 'claude-code', n: 5 }, { value: 'hermes', n: 1 }, { value: 'zen-agent', n: 1 }, { value: 'codex', n: 1 }],
    host: [{ value: 'server-a', n: 5 }, { value: 'laptop', n: 2 }, { value: 'server-b', n: 1 }],
    profile: [{ value: 'main', n: 1 }, { value: 'kitchen', n: 1 }],
    provider: [{ value: 'provider-x', n: 1 }, { value: 'provider-y', n: 1 }, { value: 'local', n: 1 }],
    channel: [{ value: 'telegram', n: 1 }, { value: 'web', n: 1 }, { value: 'remote-control', n: 1 }],
    tool: [{ value: 'Bash', n: 7 }, { value: 'Read', n: 7 }, { value: 'Edit', n: 5 }, { value: 'Grep', n: 4 }, { value: 'WebSearch', n: 1 }],
    type: [{ value: 'headless', n: 3 }, { value: 'telegram', n: 1 }, { value: 'web', n: 1 }, { value: 'cli', n: 1 }, { value: 'remote-control', n: 1 }, { value: 'unknown', n: 1 }],
    persona: [{ value: 'ada', n: 2 }, { value: 'brook', n: 2 }, { value: 'cyd', n: 1 }, { value: 'dell', n: 1 }],
  },
} satisfies { facets: AgentSessionFacets };

export const usageRunning = {
  host: 'server-a',
  at: NOW,
  rows: [
    { kind: 'bot', name: 'brook', runtime: 'zen-agent', model: LONG_MODEL, pid: 48211, user: 'app', elapsedSec: 1290, startedAt: '2026-11-14T11:38:30Z', runId: 'run-0e51-2', reason: 'task', ref: 't_0e51', state: 'running', configured: { runtime: 'claude-code', model: MODEL }, detail: null },
    { kind: 'bot', name: 'cyd', runtime: 'claude-code', model: null, pid: null, user: null, elapsedSec: 95, startedAt: '2026-11-14T11:58:25Z', runId: null, reason: 'mention', ref: null, state: 'claimed', configured: { runtime: 'claude-code', model: null }, detail: 'claimed 95 s ago, no process found' },
    { kind: 'lane', name: 'product lane worker on card t_0d41', runtime: 'claude-code', model: MODEL, pid: 48302, user: 'app', elapsedSec: 7505, startedAt: '2026-11-14T09:54:55Z', runId: 'lane-product-0d41', reason: 'task', ref: 't_0d41', state: 'running', configured: null, detail: null },
    { kind: 'lane', name: 'growth', runtime: 'unknown', model: null, pid: 48377, user: 'app', elapsedSec: 12, startedAt: null, runId: null, reason: null, ref: null, state: 'running', configured: null, detail: null },
    { kind: 'other', name: 'cron: daily-garden-digest (profile main)', runtime: 'hermes', model: 'provider-x/chat-medium', pid: 47990, user: 'app', elapsedSec: 351_000, startedAt: '2026-11-10T10:30:00Z', runId: null, reason: null, ref: null, state: 'running', configured: null, detail: null },
    { kind: 'other', name: 'interactive session', runtime: 'claude-code', model: SMALL_MODEL, pid: 51002, user: 'sam', elapsedSec: 40, startedAt: '2026-11-14T11:59:20Z', runId: null, reason: null, ref: null, state: 'running', configured: null, detail: null },
  ],
  configured: { 'claude-code': 3, 'zen-agent': 1 },
} satisfies RunningNow;

export const usageLive = {
  at: NOW,
  serverMachine: 'server-a',
  total: 3,
  machines: [
    { slug: 'server-a', display: 'Server A', kind: 'server', agents: [
      { id: 'server-a:48211', machine: 'server-a', harness: 'zen-agent', name: 'brook', model: LONG_MODEL, task: { cardId: 't_0e51', label: 'Reminder scheduler: one row per bed and day, idempotent on retry', reason: 'task' }, source: 'process', turns: 38, tokens: { input: 1_954_200, output: 31_400 }, startedAt: '2026-11-14T11:38:30Z', lastActivityAt: '2026-11-14T11:59:50Z', elapsedSec: 1290, log: { host: 'server-a', externalId: '7f3a1c9e-0001-4b7d-8f21-aaaaaaaa0001', source: 'claude-code' }, pid: 48211, runId: 'run-0e51-2', stoppable: true },
      { id: 'server-a:48302', machine: 'server-a', harness: 'claude-code', name: 'product lane', model: MODEL, task: null, source: 'process', turns: null, tokens: null, startedAt: '2026-11-14T09:54:55Z', lastActivityAt: null, elapsedSec: 7505, log: null, pid: 48302, runId: null, stoppable: false },
    ] },
    { slug: 'laptop', display: 'Laptop', kind: 'laptop', agents: [
      { id: 'laptop:s905', machine: 'laptop', harness: 'claude-code', name: 'interactive session', model: null, task: { cardId: null, label: null, reason: null }, source: 'session', turns: 6, tokens: { input: 12_900, output: 410 }, startedAt: '2026-11-13T21:02:00Z', lastActivityAt: '2026-11-14T11:59:30Z', elapsedSec: null, log: { host: 'laptop', externalId: '7f3a1c9e-0005-4b7d-8f21-aaaaaaaa0005', source: 'claude-code' }, pid: null, runId: null, stoppable: false },
    ] },
    { slug: 'server-b', display: 'Server B', kind: null, agents: [] },
  ],
} satisfies LiveNow;

const summary = (id: number, extra: Partial<AgentSummary> & Pick<AgentSummary, 'request' | 'done' | 'outcome' | 'external_id'>): AgentSummary => ({
  id, session_id: 900 + id, harness: 'claude-code', host: 'server-a', profile: null, project: null, started_at: null, ended_at: null, learned: '', open_items: '',
  touched: { files_edited: [], files_read: 0, cards: [], tools: {}, skills: [] },
  metrics: { steps: 0, prompts: 1, tool_calls: 0, error_steps: 0, duration_s: null, calls: 0, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0, models: [] },
  writer_provider: 'provider-x', writer_model: 'chat-medium', title: null, source: 'claude-code', proposed_facts: 0, ...extra,
});

export const summaries = {
  summaries: [
    summary(1, {
      external_id: '7f3a1c9e-0001-4b7d-8f21-aaaaaaaa0001', project: 'garden-app', profile: 'main', title: 'Reminder scheduler', started_at: '2026-11-14T11:20:00Z', ended_at: '2026-11-14T11:41:30Z', outcome: 'finished',
      request: 'Build the reminder scheduler: one row per bed and day, idempotent on retry.', done: 'Added the scheduler table and the job, with a unique key on bed and day. 195 tests pass.',
      learned: 'The notification library drops a reminder silently when the permission was revoked; the job now records that as skipped.', open_items: 'The quiet period is a separate card.',
      touched: { files_edited: ['src/reminders/scheduler.ts', 'src/reminders/scheduler.test.ts', 'db/migrations/0042_reminders.sql'], files_read: 31, cards: ['t_0e51'], tools: { Bash: 40, Edit: 22, Read: 31 }, skills: ['card-runner'] },
      metrics: { steps: 214, prompts: 2, tool_calls: 96, error_steps: 3, duration_s: 1290, calls: 52, input_tokens: 18_200, cache_write_tokens: 96_000, cache_read_tokens: 1_840_000, output_tokens: 31_400, models: [MODEL, SMALL_MODEL] }, proposed_facts: 1,
    }),
    summary(2, {
      external_id: '7f3a1c9e-0007-4b7d-8f21-aaaaaaaa0007', harness: 'codex', source: 'codex', host: 'server-b', started_at: '2026-11-14T09:02:00Z', ended_at: '2026-11-14T09:10:00Z', outcome: 'partial',
      request: 'Write rejected rows of the seed catalogue import to a review file.', done: 'The file is written, but two rows with empty Latin names are still dropped.',
      open_items: 'Fix the two missing rows; the fixture check fails.', metrics: { steps: 120, prompts: 1, tool_calls: 58, error_steps: 12, duration_s: 480, calls: 30, input_tokens: 9_100, cache_write_tokens: 41_000, cache_read_tokens: 720_000, output_tokens: 12_800, models: ['codex-large-2026-10'] },
      touched: { files_edited: ['importer/rows.py'], files_read: 12, cards: ['t_0f61'], tools: { shell: 58 }, skills: [] },
    }),
    summary(3, {
      external_id: '7f3a1c9e-0002-4b7d-8f21-aaaaaaaa0002', harness: 'hermes', source: 'hermes', host: 'laptop', profile: 'kitchen', ended_at: '2026-11-14T07:15:40Z', outcome: 'failed', writer_provider: null, writer_model: null,
      request: 'daily-update', done: 'Stopped: the inbox folder was not found.',
    }),
  ],
} satisfies { summaries: AgentSummary[] };

export const summaryOverview = {
  from: '2026-11-07T12:00:00Z', to: '2026-11-14T12:00:00Z', tz: 'UTC', summarized: 61, skipped: 9, proposed_facts: 4,
  outcomes: [{ key: 'finished', n: 44 }, { key: 'partial', n: 8 }, { key: 'blocked', n: 3 }, { key: 'failed', n: 4 }, { key: 'unknown', n: 2 }],
  days: [
    { day: '2026-11-14', sessions: 12, finished: 9, stuck: 2, tokens: 10_170_800, errors_per_session: 1.3 },
    { day: '2026-11-13', sessions: 15, finished: 12, stuck: 1, tokens: 14_902_000, errors_per_session: 0.8 },
    { day: '2026-11-12', sessions: 9, finished: 7, stuck: 0, tokens: 6_300_500, errors_per_session: 0.4 },
    { day: '2026-11-11', sessions: 11, finished: 8, stuck: 3, tokens: 9_050_000, errors_per_session: 2.1 },
    { day: '2026-11-10', sessions: 7, finished: 5, stuck: 1, tokens: 3_420_000, errors_per_session: 0.6 },
    { day: '2026-11-09', sessions: 2, finished: 2, stuck: 0, tokens: 240_000, errors_per_session: 0 },
    { day: '2026-11-08', sessions: 5, finished: 1, stuck: 2, tokens: 1_870_000, errors_per_session: 11.5 },
  ],
  writers: [{ key: 'provider-x/chat-medium', n: 58, input: 1_200_000, output: 90_000 }, { key: 'local/tiny-instruct-q4', n: 3, input: 40_000, output: 2_100 }],
} satisfies SummaryOverview;

// ---- ring ----

const ringDay = (day: string, score: number | null, extra: Partial<RingDay> = {}): RingDay => ({
  day, sleep_score: score, total_sleep_min: score == null ? null : 380 + score, time_in_bed_min: score == null ? null : 430 + score, deep_min: score == null ? null : 62,
  rem_min: score == null ? null : 88, light_min: score == null ? null : 240, awake_min: score == null ? null : 34, sleep_efficiency_pct: score == null ? null : 89.5,
  restorative_pct: score == null ? null : 33.2, temp_deviation_c: score == null ? null : -0.12, spo2_pct: score == null ? null : 96.4,
  bedtime_start: score == null ? null : Date.parse(`${day}T00:00:00Z`) / 1000 - 3600, bedtime_end: score == null ? null : Date.parse(`${day}T00:00:00Z`) / 1000 + 6.5 * 3600,
  steps_total: 8200, hrv_avg: 48, sleep_hrv: score == null ? null : 52, sleep_rhr: score == null ? null : 54, recovery_index: 71, movement_index: 64, active_min: 47, vo2_max: 44.1, ...extra,
});

const ringDays: RingDay[] = [
  ringDay('2026-11-14', 84),
  ringDay('2026-11-13', 71, { temp_deviation_c: 0.41, spo2_pct: 94.8, steps_total: 14_302 }),
  ringDay('2026-11-12', 90, { deep_min: 104, steps_total: 3120 }),
  ringDay('2026-11-11', null, { steps_total: 9800, hrv_avg: null, recovery_index: null, movement_index: null, active_min: null, vo2_max: null }),
  ringDay('2026-11-10', 62, { total_sleep_min: 301, awake_min: 71, sleep_efficiency_pct: 74.2 }),
  ringDay('2026-11-09', 79),
  ringDay('2026-11-08', 88, { steps_total: 21_450 }),
  ringDay('2026-11-07', 55, { total_sleep_min: 268, restorative_pct: 21.9, sleep_hrv: null }),
  ringDay('2026-11-06', 81),
  ringDay('2026-11-05', 77, { steps_total: null }),
];

export const ringOverview = { days: ringDays, total_days: 143, last_received: '2026-11-14T07:10:00Z', can_pull: true } satisfies RingOverview;

const nightStart = Date.parse('2026-11-13T23:00:00Z') / 1000;
const stageNames = ['light_sleep', 'deep_sleep', 'light_sleep', 'rem_sleep', 'awake', 'light_sleep', 'deep_sleep', 'rem_sleep', 'light_sleep', 'awake'];
export const ringNight = {
  day: ringDays[0]!,
  stages: stageNames.map((stage, i) => ({ start: nightStart + i * 2700, end: nightStart + (i + 1) * 2700, stage })),
  heart_rate: Array.from({ length: 30 }, (_, i) => ({ ts: nightStart + i * 900, value: 52 + ((i * 7) % 11) })),
  hrv: Array.from({ length: 30 }, (_, i) => ({ ts: nightStart + i * 900, value: 44 + ((i * 5) % 17) })),
} satisfies RingNight;

// ---- fund ----

// Obviously made-up chain values: a counter padded to the right length, as the fund test does.
const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const txHash = (c: string): string => `0x${c.repeat(64)}`;

export const fundOverview = {
  configured: true,
  dir: 'Areas/fund',
  chainId: 8453,
  explorer: 'https://explorer.example',
  threshold: 2,
  ethUsd: 3120.55,
  navUsd: 1284.37,
  navPartial: true,
  wallets: [
    { key: 'safe', label: 'Fund Safe', role: 'Holds the fund. Two signatures move anything.', address: addr(1), balances: [{ symbol: 'USDC', amount: 902.11, usd: 902.11 }, { symbol: 'WETH', amount: 0.1225, usd: 382.26 }, { symbol: 'NEWTOKEN', amount: 15000, usd: null }], usd: 1284.37, partial: true, error: null },
    { key: 'agent', label: 'Agent', role: 'Proposes trades; cannot sign alone.', address: addr(2), balances: [{ symbol: 'ETH', amount: 0.0041, usd: 12.79 }], usd: 12.79, partial: false, error: null },
    { key: 'deck', label: 'Deck', role: 'First signer.', address: null, balances: [], usd: null, partial: false, error: 'address not set' },
  ],
  pending: [
    { id: 'p7', created: '2026-11-14T09:00:00Z', kind: 'swap', title: 'Sell 120 USDC for WETH after the committee vote of 13 November', status: 'awaiting signatures', tally: '3 for, 1 against', meeting: 'Areas/fund/meetings/2026-11-13.md',
      votes: [{ partner: 'wren', vote: 'for', reason: 'Fees are rising and the position is small.' }, { partner: 'basil', vote: 'against', reason: 'Already priced in.' }], txHash: null, result: null },
  ],
  proposals: [],
  transactions: [
    { when: '2026-11-13T18:20:00Z', kind: 'swap', title: 'Sell 30 USDC for WETH on the main pool, slippage limit half a percent', hash: txHash('a'), proposal: 'p6', confirmed: true, gasEth: 0.0000213 },
    { when: '2026-11-12T10:05:00Z', kind: 'transfer-in', title: 'Received 100 USDC', hash: txHash('b'), proposal: null, confirmed: true, gasEth: null },
    { when: '2026-11-11T22:40:00Z', kind: 'failed', title: 'Sell 15000 NEWTOKEN for USDC: the route had no liquidity and the transaction reverted', hash: txHash('c'), proposal: 'p5', confirmed: false, gasEth: 0.0000098 },
    { when: '2026-11-11T08:00:00Z', kind: 'refused', title: 'Buy 400 USDC of NEWTOKEN: over the single-position limit', hash: null, proposal: 'p4', confirmed: null, gasEth: null },
    { when: '2026-11-10T15:30:00Z', kind: 'withdraw', title: 'Withdraw 50 USDC to savings', hash: txHash('d'), proposal: 'p3', confirmed: true, gasEth: 0.0000301 },
    { when: '2026-11-10T09:00:00Z', kind: 'expired', title: 'Sell 0.02 WETH for USDC', hash: null, proposal: 'p2', confirmed: null, gasEth: null },
  ],
  meetings: [{ name: '2026-11-13.md', path: 'Areas/fund/meetings/2026-11-13.md', title: 'Committee meeting', note: '3 for, 1 against: sell 120 USDC for WETH' }],
  research: [{ name: 'fees.md', path: 'Areas/fund/research/fees.md', title: 'Fee trends', note: '' }],
  reviews: [{ name: 'october.md', path: 'Areas/fund/reviews/october.md', title: 'October review', note: '' }],
  harness: {
    header: ['Skill', 'Runs', 'Failed', 'Median minutes', 'Tokens', 'Last change', 'Why'],
    rows: [
      ['fund-research', '14', '1', '6.2', '1.9M', '2026-11-09', 'Sources are now read before the summary is written'],
      ['fund-committee', '5', '0', '11.0', '3.4M', '2026-11-02', 'Each partner votes in a separate call'],
      ['fund-execute', '9', '2', '1.4', '210k', '2026-11-11', 'Refuses a trade over the single-position limit instead of resizing it'],
      ['fund-review', '1', '0', '8.8', '640k', '2026-10-31', ''],
    ],
  },
  runs: [
    { skill: 'fund-research', at: '2026-11-14T06:00:00Z', failed: false, reason: null, file: 'Areas/fund/runs/research.json' },
    { skill: 'fund-committee', at: '2026-11-13T17:00:00Z', failed: false, reason: null, file: 'Areas/fund/runs/committee.json' },
    { skill: 'fund-execute', at: '2026-11-13T18:20:00Z', failed: true, reason: 'the second signature did not arrive within the window, so the proposal expired', file: 'Areas/fund/runs/execute.json' },
    { skill: 'fund-review', at: '2026-10-31T20:00:00Z', failed: false, reason: null, file: 'Areas/fund/runs/review.json' },
    { skill: 'fund-balance-snapshot', at: '2026-11-14T11:00:00Z', failed: false, reason: null, file: 'Areas/fund/runs/snapshot.json' },
  ],
  warnings: ['One token in the Safe has no price, so the total leaves it out.'],
  chainErrors: [],
  asOf: '2026-11-14T11:58:00Z',
} satisfies FundOverview;
