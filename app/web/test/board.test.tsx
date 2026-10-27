import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Board, { age, runtimeOf, sortCards } from '../src/routes/board/Board.js';

/** The board module's page: columns from the engine's cards, filters, the card panel, and writes as the owner. */

const CHART = {
  teams: [{ slug: 'platform', name: 'Platform', lead: 'atlas' }],
  agents: [
    { name: 'owner', team_slug: null, team_name: null, runtime: 'human', role: 'CEO', reports_to: null, model: null, expertise: null, is_lead: false, session_id: null, session_started: null, activity: null, caps: null },
    { name: 'atlas', team_slug: 'platform', team_name: 'Platform', runtime: 'claude-code', role: 'Head of Platform', reports_to: 'owner', model: null, expertise: null, is_lead: true, session_id: null, session_started: null, activity: null, caps: null },
    { name: 'rune', team_slug: 'platform', team_name: 'Platform', runtime: 'zen-agent', role: 'Platform engineer', reports_to: 'atlas', model: null, expertise: null, is_lead: false, session_id: null, session_started: null, activity: null, caps: null },
  ],
};
const card = (id: string, title: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, board_slug: 'exo', title, body: null, contract: {}, status, priority: 3, assignee: 'rune', created_by: 'owner', project_slug: 'secondbrain-app', feature_slug: 'board', kind: 'work',
  work_type: null, needs: null, ship_now: false, repo: null, graph: null, node: null, rounds: 0, scheduled_for: null, block_kind: null, block_reason: null, result: null,
  created_at: '2026-10-24T08:00:00Z', started_at: null, completed_at: null, updated_at: '2026-10-24T08:00:00Z', ...extra,
});
const CARDS = [
  card('t_00000001', 'Build the board', 'running', { kind: 'build', started_at: '2026-10-24T09:00:00Z' }),
  card('t_00000002', 'Review the board', 'todo', { kind: 'review', assignee: 'atlas' }),
  card('t_00000003', 'Think about it', 'ready', { assignee: null, project_slug: null, feature_slug: null }),
  card('t_00000004', 'Stuck', 'blocked', { block_kind: 'needs-owner', block_reason: 'which repo?' }),
];
const DETAIL = {
  card: { ...CARDS[0]!, body: 'GET /api/board', contract: { objective: 'Ship the board', returns: ['a PR'], budget: { turns: 20 } } },
  comments: [{ id: 1, author: 'owner', body: 'go', created_at: '2026-10-24T08:10:00Z' }],
  events: [{ id: 1, kind: 'created', actor: 'owner', payload: null, at: '2026-10-24T08:00:00Z' }, { id: 2, kind: 'claimed', actor: 'rune', payload: null, at: '2026-10-24T09:00:00Z' }],
  depends_on: [],
  dependants: [{ id: 't_00000002', title: 'Review the board', status: 'todo' }],
  runs: [{ id: 1, agent_name: 'rune', runtime: 'zen-agent', claimed_at: '2026-10-24T09:00:00Z', lease_until: '2026-10-24T10:00:00Z', heartbeat_at: null, finished_at: null, outcome: null, tokens: 1200, turns: 3 }],
};

function mount(path: string) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const u = new URL(url, 'http://x');
      if (u.pathname === '/api/meta') return Response.json({ modules: ['org', 'board'], owner: 'owner', devLogPath: null, docsPath: null, robot: false, version: 'test', commit: 'abc' });
      if (u.pathname === '/api/org/chart') return Response.json(CHART);
      if (u.pathname === '/api/board/boards') return Response.json({ boards: [{ slug: 'exo', name: 'Exo', team_slug: null, open: 4 }] });
      if (u.pathname === '/api/board/cards' && init?.method === 'POST') return Response.json({ card: card('t_new00001', 'Write the docs', 'ready', { assignee: 'atlas' }), message: null }, { status: 201 });
      if (u.pathname === '/api/board/cards') {
        const assignee = u.searchParams.get('assignee');
        return Response.json({ cards: assignee ? CARDS.filter((c) => (assignee === 'none' ? c.assignee === null : c.assignee === assignee)) : CARDS });
      }
      if (u.pathname === '/api/board/cards/t_00000001') return Response.json(DETAIL);
      if (u.pathname === '/api/board/cards/t_00000001/comment') return Response.json({ comment: { id: 2, author: 'owner', body: 'looks good', created_at: '2026-10-24T09:30:00Z' } }, { status: 201 });
      if (u.pathname === '/api/board/cards/t_00000001/finish') return Response.json({ card: { ...CARDS[0], status: 'done' } });
      if (u.pathname === '/api/projects/report') return Response.json({ projects: [{ slug: 'secondbrain-app', title: 'Second Brain app', team: 'platform', features: [{ slug: 'board', title: 'The board' }] }] });
      if (u.pathname === '/api/file/resolve') return Response.json({ resolved: {} });
      return Response.json({ error: { message: `unexpected ${url}` } }, { status: 404 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/board" element={<Board />} />
          <Route path="/board/:cardId" element={<Board />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('helpers', () => {
  it('ages and runtimes', () => {
    expect(age(null)).toBe('');
    expect(age(new Date(Date.now() - 30_000).toISOString())).toBe('now');
    expect(age(new Date(Date.now() - 3 * 86400_000).toISOString())).toBe('3d');
    expect(runtimeOf(CHART as never, 'rune')).toBe('zen-agent');
    expect(runtimeOf(CHART as never, 'cc-writer')).toBe('claude-code');
    expect(runtimeOf(null, null)).toBe('none');
  });
});

describe('Board page', () => {
  it('puts cards in their columns with assignee, kind and block, and filters by assignee', async () => {
    const calls = mount('/board');
    await screen.findByText('Build the board');
    const running = screen.getByRole('region', { name: 'Running' });
    expect(within(running).getByText('Build the board')).toBeTruthy();
    expect(within(running).getByText('build')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'To do' })).getByText('Review the board')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Ready' })).getByText('unassigned')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Blocked' })).getByText('⛔ needs-owner')).toBeTruthy();
    expect(screen.getByText(/4 cards/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Anyone'), { target: { value: 'atlas' } });
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/board/cards?') && c.url.includes('assignee=atlas'))).toBe(true));
    await waitFor(() => expect(screen.queryByText('Build the board')).toBeNull());
    expect(screen.getByText('Review the board')).toBeTruthy();
  });

  it('opens a card: contract, dependants, runs, comments; comments and finishes as the owner', async () => {
    const calls = mount('/board/t_00000001');
    const panel = await screen.findByRole('complementary', { name: 'Card' });
    await within(panel).findByText('GET /api/board');
    expect(within(panel).getByText('Ship the board')).toBeTruthy();
    expect(within(panel).getByText('a PR')).toBeTruthy();
    expect(within(panel).getByText('turns: 20')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 't_00000002 [todo]' }).getAttribute('href')).toBe('/board/t_00000002');
    expect(within(panel).getByText(/rune \(zen-agent\)/)).toBeTruthy();
    expect(within(panel).getByText(/1,200 tokens/)).toBeTruthy();
    expect(within(panel).getByText('go')).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText('Comment'), { target: { value: 'looks good' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/comment') && c.init?.method === 'POST')).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/comment'))!.init?.body))).toEqual({ body: 'looks good' });
    fireEvent.click(within(panel).getByRole('button', { name: 'mark done' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/finish') && c.init?.method === 'POST')).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/finish'))!.init?.body))).toEqual({ outcome: 'done' });
  });

  it('creates a card for a roster bot, tagged with a project and feature', async () => {
    const calls = mount('/board');
    await screen.findByText('Build the board');
    fireEvent.click(screen.getByRole('button', { name: 'New card' }));
    const form = screen.getByRole('form', { name: 'New card' });
    fireEvent.change(within(form).getByLabelText('Card title'), { target: { value: 'Write the docs' } });
    await within(form).findByRole('option', { name: /Head of Platform/ });
    fireEvent.change(within(form).getByLabelText('Agent'), { target: { value: 'atlas' } });
    await within(form).findByRole('option', { name: 'secondbrain-app' });
    fireEvent.change(within(form).getByLabelText('Project'), { target: { value: 'secondbrain-app' } });
    fireEvent.change(within(form).getByLabelText('Feature'), { target: { value: 'board' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Give it to atlas' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/board/cards') && c.init?.method === 'POST')).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/api/board/cards') && c.init?.method === 'POST')!.init?.body))).toEqual({
      board: undefined, title: 'Write the docs', body: undefined, assignee: 'atlas', project: 'secondbrain-app', feature: 'board', kind: 'work', priority: 3,
    });
  });
});

describe('sortCards', () => {
  const a = card('t_a', 'a', 'todo', { created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-27T00:00:00Z', priority: 3 });
  const b = card('t_b', 'b', 'todo', { created_at: '2026-10-25T00:00:00Z', updated_at: '2026-10-21T00:00:00Z', priority: 1 });
  const c = card('t_c', 'c', 'todo', { created_at: '2026-10-23T00:00:00Z', updated_at: '2026-10-22T00:00:00Z', priority: 3 });
  const ids = (s?: string) => sortCards([a, b, c] as never, s).map((x) => x.id);
  it('defaults to newest created first', () => { expect(ids()).toEqual(['t_b', 't_c', 't_a']); expect(ids('bogus')).toEqual(['t_b', 't_c', 't_a']); });
  it('sorts oldest, recently updated and priority', () => {
    expect(ids('oldest')).toEqual(['t_a', 't_c', 't_b']);
    expect(ids('updated')).toEqual(['t_a', 't_c', 't_b']);
    expect(ids('priority')).toEqual(['t_b', 't_c', 't_a']);
  });
});
