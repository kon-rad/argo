import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Projects from '../src/routes/Projects.js';

const counts = { idea: 1, designing: 0, building: 0, testing: 1, live: 0, parked: 0, done: 0 };
const feature = (slug: string, title: string, stage: string) => ({
  id: slug === 'core' ? 1 : 2, slug, title, stage, health: null, owner: 'claude-code', goals: [], needs_owner: null, blocked_on: null,
  due: null, shipped_at: null, notes_path: null, updated_at: '2026-10-14T00:00:00Z', updated_by: 't', days_in_stage: 3,
  verification: null, verifications_total: 0,
});
const REPORT = {
  as_of: '2026-10-14T00:00:00Z',
  generated_at: '2026-10-14T00:00:00Z',
  totals: { projects: { ...counts, idea: 0, testing: 0, building: 1 }, features: counts },
  needs_owner: [{ project: 'lifeos', feature: null, title: 'argo-lifeos', detail: 'Write the README pitch', priority: 2, due: null }],
  divisions: [{ slug: 'lifeos', name: 'LifeOS', projects: ['lifeos'], in_flight: 1, shipped_7d: 0, needs_owner: 1, stages: { ...counts, idea: 0, testing: 0, building: 1 } }],
  teams: [{ slug: 'platform', name: 'Platform', lead: 'claude-code', projects: ['lifeos'], in_flight: 1, shipped_7d: 0, needs_owner: 1, stages: { ...counts, idea: 0, testing: 0, building: 1 } }],
  goals: [{ code: 'W2', horizon: 'This week', goal: 'Livestream', due: '2026-10-18', status: 'open', projects: [], features: [] }],
  gaps: {
    goals_uncovered: [{ code: 'W2', horizon: 'This week', goal: 'Livestream', due: '2026-10-18', status: 'open', projects: [], features: [] }],
    unverified_shipped: [], failing: [], testing_unverified: [{ project: 'lifeos', feature: 'core', title: 'Headless core', detail: '3d in testing' }],
    stale: [], overdue: [], no_team: [], no_division: [], no_features: [],
  },
  oldest: [], backlog: { total: 1, by_project: [{ project: 'lifeos', count: 1, oldest_days: 3 }] }, moved_7d: [], shipped_7d: [],
  verified_7d: { pass: 0, fail: 0 },
  projects: [
    {
      slug: 'lifeos', title: 'argo-lifeos', team: 'platform', division: 'lifeos', area: 'argo', stage: 'building', health: 'green', priority: 2, goals: ['W1'],
      needs_owner: 'Write the README pitch', blocked_on: null, due: null, devlog_path: 'Areas/x/dev-log/README.md', design_path: null,
      updated_at: '2026-10-14T00:00:00Z', days_in_stage: 2, next_action: 'Write /v1/days', counts, progress: 0,
      features: [feature('core', 'Headless core', 'testing'), feature('mcp', 'MCP server', 'idea')],
    },
  ],
};

function mount(path: string, patch?: (url: string, init?: RequestInit) => Response | undefined) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const custom = patch?.(url, init);
      if (custom) return custom;
      return Response.json(url.includes('format=markdown') ? { text: '# Company Report', as_of: null } : REPORT);
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Projects />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Projects page', () => {
  it('overview shows needs-you and the gaps', async () => {
    mount('/projects');
    expect(await screen.findByRole('heading', { name: 'Needs you (1)' })).toBeTruthy();
    expect(screen.getAllByText(/Write the README pitch/).length).toBeGreaterThan(0);
    expect(screen.getByText(/W2 Livestream/)).toBeTruthy();
  });

  it('board puts features in stage columns and shows a refused move', async () => {
    mount('/projects?view=board', (url, init) =>
      init?.method === 'PATCH' ? Response.json({ error: { message: "can't move to live: it has no verification" } }, { status: 409 }) : undefined,
    );
    expect(await screen.findByText('Headless core')).toBeTruthy();
    expect(screen.getByText('Testing (1)')).toBeTruthy();
    expect(screen.getByText('Next:')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Stage of Headless core'), { target: { value: 'live' } });
    await waitFor(() => expect(screen.getByText(/has no verification/)).toBeTruthy());
  });

  it('board shows a feature\'s cards with the bot and status, and gives a new card to the team lead by default', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    mount('/projects?view=board', (url, init) => {
      calls.push({ url, init });
      const u = new URL(url, 'http://x');
      if (u.pathname === '/api/org/tasks') return Response.json({ tasks: [{ task_id: 't_abc123', board: 'exo', title: 'Write /v1/days', project_slug: 'lifeos', feature_slug: 'core', assignee: 'rune', created_by: 'owner', rounds: 1, created_at: '2026-10-15T05:00:00Z', status: 'running' }] });
      if (u.pathname === '/api/org/chart') return Response.json({ teams: [{ slug: 'platform', name: 'Platform', lead: 'atlas' }, { slug: 'media', name: 'Media', lead: 'juno' }], agents: [
        { name: 'owner', team_slug: null, team_name: null, runtime: 'human', role: 'CEO', is_lead: false },
        { name: 'atlas', team_slug: 'platform', team_name: 'Platform', runtime: 'claude-code', role: 'Head of Platform', is_lead: true },
        { name: 'rune', team_slug: 'platform', team_name: 'Platform', runtime: 'claude-code', role: 'Platform engineer', is_lead: false },
        { name: 'juno', team_slug: 'media', team_name: 'Media', runtime: 'claude-code', role: 'Head of Media', is_lead: true },
      ] });
      if (u.pathname === '/api/board/cards' && init?.method === 'POST') return Response.json({ card: { id: 't_new000', title: 'Add tests', status: 'ready', assignee: 'atlas' }, message: null }, { status: 201 });
      return undefined;
    });
    expect(await screen.findByText('Headless core')).toBeTruthy();
    const cards = await screen.findByLabelText('Cards for Headless core');
    expect(cards.textContent).toContain('rune');
    expect(cards.textContent).toContain('Write /v1/days');
    expect(cards.textContent).toContain('running');
    expect(cards.textContent).toContain('round 1');
    const card = screen.getByText('Headless core').closest('div.rounded') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'give to a bot' }));
    const bot = (await screen.findByLabelText('Bot for Headless core')) as HTMLSelectElement;
    expect(bot.value).toBe('atlas'); // the project team's lead
    expect(screen.getByRole('option', { name: 'juno (Media)' })).toBeTruthy(); // other teams are marked
    fireEvent.change(screen.getByLabelText('Card title for Headless core'), { target: { value: 'Add tests' } });
    fireEvent.click(screen.getByRole('button', { name: 'Give to atlas' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/board/cards') && c.init?.method === 'POST')).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/api/board/cards') && c.init?.method === 'POST')!.init?.body))).toEqual({ title: 'Add tests', assignee: 'atlas', project: 'lifeos', feature: 'core' });
  });

  it('divisions view groups projects under their division', async () => {
    mount('/projects?view=divisions');
    expect(await screen.findByRole('heading', { name: 'LifeOS' })).toBeTruthy();
    expect(screen.getByText(/1 projects · 1 features in flight/)).toBeTruthy();
  });

  it('goals view flags goals with nothing linked', async () => {
    mount('/projects?view=goals');
    expect(await screen.findByText('nothing linked')).toBeTruthy();
  });
});
