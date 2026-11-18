/**
 * One answer for every /api call the table views make, from the fake fixtures in tables.ts. Shared by the jsdom route
 * tests (test/tables-routes.test.tsx) and the browser checks (e2e/mock-api.ts), so both look at the same data.
 */
import * as fx from './tables.js';

type Reply = unknown | ((url: URL) => unknown);

/** Exact `METHOD /path` (the path after /api) to its JSON answer. */
const EXACT: Record<string, Reply> = {
  // the shell
  'GET /auth/me': fx.auth,
  'GET /meta': fx.meta,
  'GET /sync': fx.syncState,
  'GET /sources': fx.sources,
  'GET /runs': { runs: [] },
  'GET /system': { vault_root: 'vault', counts: { files: 0, markdown: 0, links: 0, tags: 0 }, embeddings: { chunks: 0, files_embedded: 0, files_embeddable: 0, model: null, last_embedded_at: null } },
  'GET /tree': (url: URL) => {
    const path = url.searchParams.get('path') ?? '';
    return path === '' ? fx.tree : { path, dirs: [], files: [], total: 0, has_more: false };
  },
  'GET /file': fx.fileResponse,
  'GET /file/resolve': { resolved: {} },
  // projects
  'GET /areas/report': (url: URL) => (url.searchParams.get('format') === 'markdown' ? fx.projectsMarkdown : fx.projectsReport),
  'GET /org/tasks': { tasks: [] },
  // board
  'GET /board/boards': fx.boardBoards,
  'GET /board/cards': fx.boardCards,
  'GET /board/tokens': fx.boardTokens,
  // org
  'GET /org/chart': fx.orgChart,
  'GET /org/approvals': fx.orgApprovals,
  'GET /org/channels': { channels: [] },
  'GET /org/messages': { messages: [], cursor: 0 },
  'GET /org/facts': [],
  // database
  'GET /db/schema': fx.dbSchema,
  'POST /db/query': fx.dbQueryResult,
  // cron
  'GET /agents/cron/jobs': fx.cronJobs,
  'GET /agents/cron/timers': fx.cronTimers,
  // usage
  'GET /usage/config': fx.usageConfig,
  'GET /usage/plan': fx.usagePlan,
  'GET /usage/series': fx.usageSeries,
  'GET /usage/facets': fx.usageFacets,
  'GET /usage/runs': fx.usageRuns,
  'GET /usage/org-wakes': fx.usageOrgWakes,
  'GET /usage/credits': fx.usageCredits,
  'GET /usage/subscriptions': fx.usageSubscriptions,
  'GET /usage/agent-sessions': fx.agentSessions,
  'GET /usage/agent-sessions/facets': fx.agentSessionFacets,
  'GET /usage/running': fx.usageRunning,
  'GET /usage/live': fx.usageLive,
  'GET /usage/hosts': { hosts: [] },
  'GET /summaries': fx.summaries,
  'GET /summaries/overview': fx.summaryOverview,
  'GET /hub/telegram': { default: 'claude', claude_running: false, hermes_running: false, claude_bot_configured: false, bots_distinct: false },
  // ring, fund
  'GET /ring': fx.ringOverview,
  'GET /fund': fx.fundOverview,
};

/** Paths with a parameter. A handler that returns undefined means "no such thing": the call is answered 404. */
const PATTERNS: { method: string; re: RegExp; reply: (m: RegExpMatchArray) => unknown }[] = [
  {
    method: 'GET', re: /^\/agents\/cron\/jobs\/([^/]+)\/([^/]+)$/,
    reply: (m) => {
      const job = fx.cronJobs.jobs.find((j) => j.profile === decodeURIComponent(m[1]!) && j.job_id === decodeURIComponent(m[2]!));
      return job ? { ...fx.cronJobDetail, job } : undefined;
    },
  },
  { method: 'GET', re: /^\/ring\/night\/([^/]+)$/, reply: () => fx.ringNight },
  {
    method: 'GET', re: /^\/board\/cards\/([^/]+)$/,
    reply: (m) => {
      const card = fx.boardCards.cards.find((c) => c.id === decodeURIComponent(m[1]!));
      return card ? { card, comments: [], events: [], depends_on: [], dependants: [], runs: [] } : undefined;
    },
  },
  { method: 'GET', re: /^\/org\/channels\/[^/]+\/members$/, reply: () => ({ members: [] }) },
];

/**
 * Misses the app expects, not worth a fixture or a warning: an <img> that falls back to an initial when the picture
 * is missing, and the settings of a module (voice) that is off in these fixtures, as its route is on a real server.
 */
const QUIET_404 = [/^\/org\/avatar\//, /^\/voice\/settings$/];

/**
 * The JSON for `METHOD /path` (the path after /api), or `missing` when nothing answers it. `quiet` marks a miss
 * the app expects, which a test need not report.
 */
export function answer(method: string, url: URL): { body: unknown } | { missing: true; quiet: boolean } {
  const path = url.pathname.replace(/^\/api/, '');
  const exact = EXACT[`${method} ${path}`];
  if (exact !== undefined) return { body: typeof exact === 'function' ? (exact as (url: URL) => unknown)(url) : exact };
  for (const p of PATTERNS) {
    if (p.method !== method) continue;
    const m = path.match(p.re);
    if (!m) continue;
    const body = p.reply(m);
    if (body !== undefined) return { body };
  }
  return { missing: true, quiet: QUIET_404.some((re) => re.test(path)) };
}
