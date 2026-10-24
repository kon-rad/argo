import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Org, { channelLabel, teamColor } from '../src/routes/org/Org.js';

const agent = (name: string, team_slug: string | null, role: string, is_lead = false) => ({
  name, team_slug, team_name: team_slug === 'platform' ? 'Platform & Agents' : team_slug ? 'Media & Growth' : null, runtime: team_slug ? 'claude-code' : 'human',
  role, reports_to: is_lead ? 'owner' : team_slug ? 'atlas' : null, model: 'opus', expertise: null, is_lead, session_id: null, session_started: null,
  activity: { last_wake: '2026-10-15T04:21:00Z', wakes_today: 1, open_wakeups: 0, unread: 2, last_post: '2026-10-15T04:22:00Z' },
  caps: { wakes_per_day: 6, cooldown_minutes: 10, max_runtime_minutes: 30, lane: null, routines: [{ name: 'daily-standup', at: '05:30', kind: 'standup' }] },
});
const CHART = {
  teams: [{ slug: 'platform', name: 'Platform & Agents', lead: 'atlas' }, { slug: 'media', name: 'Media & Growth', lead: 'juno' }],
  agents: [agent('owner', null, 'CEO'), agent('atlas', 'platform', 'Head of Platform', true), agent('rune', 'platform', 'Platform engineer'), agent('juno', 'media', 'Head of Media', true)],
};
const CHANNELS = {
  channels: [
    { slug: 'all-hands', kind: 'shared', purpose: 'company-wide', members: 4, unread: 0 },
    { slug: 'platform', kind: 'team', purpose: 'the platform team', members: 3, unread: 2 },
    { slug: 'dm:atlas:owner', kind: 'dm', purpose: null, members: 2, unread: 0 },
  ],
};
const msg = (id: number, channel_slug: string, author: string, body: string, extra: Record<string, unknown> = {}) => ({
  id, channel_slug, thread_id: null, author, kind: 'message', body, mentions: [], urgent: false, task_id: null, project_slug: null, feature_slug: null, run_id: null,
  created_at: '2026-10-15T04:22:00Z', ...extra,
});
const MESSAGES: Record<string, unknown[]> = {
  'all-hands': [msg(1, 'all-hands', 'owner', 'Morning all')],
  platform: [
    msg(2, 'platform', 'atlas', 'shipped: the board', { kind: 'standup' }),
    msg(3, 'platform', 'rune', 'tests 29/29', { kind: 'status', task_id: 't_abc123' }),
    msg(4, 'platform', 'atlas', 'good', { kind: 'reply', thread_id: 3 }),
  ],
};
const AGENT_PAGE = {
  agent: { name: 'atlas', team_slug: 'platform', runtime: 'claude-code', role: 'Head of Platform', reports_to: 'owner', model: 'opus', expertise: null },
  team: { slug: 'platform', name: 'Platform & Agents', lead: 'atlas' },
  is_lead: true,
  reports: ['rune'],
  channels: [{ slug: 'platform', kind: 'team', unread: 1 }],
  open_wakeups: [{ id: 9, agent_name: 'atlas', reason: 'owner', ref: '5', created_at: '2026-10-15T05:00:00Z', claimed_at: null, done_at: null }],
  runs: [{ id: 8, agent_name: 'atlas', reason: 'routine', ref: 'daily-standup', created_at: '2026-10-15T04:20:00Z', claimed_at: '2026-10-15T04:21:00Z', done_at: '2026-10-15T04:22:00Z', claimed_by: 'org-atlas-1', result: 'posted the stand-up' }],
  posts: [msg(2, 'platform', 'atlas', 'shipped: the board', { kind: 'standup' })],
  caps: { wakes_per_day: 6, cooldown_minutes: 10, max_runtime_minutes: 30, lane: null, routines: [] },
  prompt: '# atlas\n\n**Personality.** Calm, exact.',
  memory: '- 2026-10-15: learned the board',
  memory_path: '.agents/org/memory/atlas.md',
  core: '# atlas: core memory\n\n## Lessons\n- [m-3 ×2 · 2026-10-15] I post the stand-up before reading the backlog.',
  core_path: '.agents/org/memory/atlas/core.md',
  memory_rows: [
    { id: 3, agent_name: 'atlas', kind: 'lesson', content: 'I post the stand-up before reading the backlog.', evidence_episode_ids: [1, 2], occurrences: 2, active: true, retired_why: null, supersedes: null, promoted_to_proposal: false, proposal_task_id: null, proposed_at: null, created_at: '2026-10-14T05:00:00Z', updated_at: '2026-10-15T05:00:00Z' },
    { id: 4, agent_name: 'atlas', kind: 'friction', content: 'I get sent back when a review card has no PR link.', evidence_episode_ids: [2, 5], occurrences: 2, active: true, retired_why: null, supersedes: null, promoted_to_proposal: true, proposal_task_id: 't_prop001', proposed_at: '2026-10-15T06:00:00Z', created_at: '2026-10-14T05:00:00Z', updated_at: '2026-10-15T05:00:00Z' },
  ],
  episodes: [
    { id: 5, run_id: 'org-atlas-1', task_id: 't_abc123', reason: 'task', outcome: 'request_changes', corrected: true, turn_count: 14, cost_usd: '0.4200', duration_s: 300, summary: 'Worked card t_abc123. Sent back with changes requested.', log_path: null, reflected_at: '2026-10-15T04:23:00Z', created_at: '2026-10-15T04:22:00Z' },
  ],
  proposals: [
    { id: 4, agent_name: 'atlas', kind: 'friction', content: 'I get sent back when a review card has no PR link.', evidence_episode_ids: [2, 5], occurrences: 2, active: true, retired_why: null, supersedes: null, promoted_to_proposal: true, proposal_task_id: 't_prop001', proposed_at: '2026-10-15T06:00:00Z', created_at: '2026-10-14T05:00:00Z', updated_at: '2026-10-15T05:00:00Z', card_status: 'triage', card_title: 'self-improvement: atlas, I get sent back when a review card has no PR link.' },
  ],
  memory_stats: { days: 14, episodes: 1, done: 0, corrected: 0, corrections_per_done: null, cost_per_done: null, avg_turns: 14, reflected: 1, memory: { active: 2, by_kind: { lesson: 1, friction: 1 } }, proposals: 1 },
  memory_config: { core_budget_tokens: 1500, reflect: { enabled: true, min_turns: 2 }, self_improvement: { enabled: true, repeat_threshold: 2, max_proposals_per_week: 1 } },
};

function mount(path: string, over: { agentPage?: unknown } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const u = new URL(url, 'http://x');
      if (u.pathname === '/api/org/chart') return Response.json(CHART);
      if (u.pathname === '/api/org/channels') return Response.json(CHANNELS);
      if (u.pathname.endsWith('/members')) return Response.json({ members: [{ agent_name: 'owner', can_post: true, role: 'CEO', team_slug: null, runtime: 'human' }, { agent_name: 'atlas', can_post: true, role: 'Head of Platform', team_slug: 'platform', runtime: 'claude-code' }] });
      if (u.pathname.endsWith('/read')) return Response.json({ ok: true });
      if (u.pathname === '/api/org/messages') {
        const ch = u.searchParams.get('channel');
        const messages = ch ? (MESSAGES[ch] ?? []) : Object.values(MESSAGES).flat();
        return Response.json({ messages, cursor: 4 });
      }
      if (u.pathname === '/api/org/search') return Response.json({ messages: [msg(3, 'platform', 'rune', 'tests 29/29', { kind: 'status' })] });
      if (u.pathname === '/api/org/post') return Response.json(msg(5, 'all-hands', 'owner', 'posted'), { status: 201 });
      if (u.pathname === '/api/org/dm') return Response.json(msg(6, 'dm:atlas:owner', 'owner', 'hi'), { status: 201 });
      if (u.pathname === '/api/org/agents/atlas') return Response.json(over.agentPage ?? AGENT_PAGE);
      if (u.pathname === '/api/board/cards' && init?.method === 'POST') return Response.json({ card: { id: 't_new000', title: 'Ship it', status: 'ready', assignee: 'atlas' }, message: null }, { status: 201 });
      if (u.pathname === '/api/board/cards') return Response.json({ cards: [{ id: 't_abc123', board_slug: 'exo', title: 'Wire the tasks route', status: 'ready', assignee: 'atlas', project_slug: 'secondbrain-app', feature_slug: 'org-page', created_by: 'owner', kind: 'work', priority: 3, contract: {}, created_at: '2026-10-15T05:00:00Z' }] });
      if (u.pathname === '/api/org/tasks') return Response.json({ tasks: [{ task_id: 't_abc123', board: 'exo', title: 'Wire the tasks route', project_slug: 'secondbrain-app', feature_slug: 'org-page', assignee: 'atlas', created_by: 'owner', rounds: 0, created_at: '2026-10-15T05:00:00Z' }] });
      if (u.pathname === '/api/projects/report') return Response.json({ projects: [{ slug: 'secondbrain-app', title: 'Second Brain app', team: 'platform', features: [{ slug: 'org-page', title: 'The /org page' }] }] });
      return Response.json({ error: { message: `unexpected ${url}` } }, { status: 404 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/org/*" element={<Org />} />
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
  it('labels channels and colours teams stably', () => {
    expect(channelLabel('platform')).toBe('#platform');
    expect(channelLabel('dm:atlas:owner')).toBe('atlas ↔ owner');
    expect(teamColor('platform')).toBe(teamColor('platform'));
    expect(teamColor('platform')).not.toBe(teamColor('media'));
    expect(teamColor(null)).toBe('var(--ink-dim)');
  });
});

describe('Org page', () => {
  it('opens all-hands by default, lists channels with unread badges, and posts as owner', async () => {
    const calls = mount('/org');
    await screen.findByText('Morning all');
    const sidebar = screen.getByRole('complementary', { name: 'Channels' });
    expect(within(sidebar).getByText('#platform')).toBeTruthy();
    expect(within(sidebar).getByLabelText('2 unread').textContent).toBe('2');
    expect(screen.getByRole('complementary', { name: 'Members' }).textContent).toContain('Head of Platform');

    fireEvent.change(screen.getByLabelText('Message #all-hands'), { target: { value: 'Ship it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/org/post') && c.init?.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.url.endsWith('/api/org/post'))!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ channel: 'all-hands', body: 'Ship it' });
  });

  it('opens a channel at its newest message and posts on Enter, Shift+Enter keeps a new line', async () => {
    // jsdom has no layout: give every box a tall scrollHeight so "the bottom" is a number.
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(5000);
    const calls = mount('/org?channel=platform');
    await screen.findByText('shipped: the board');
    await waitFor(() => expect(screen.getByTestId('channel-messages').scrollTop).toBe(5000));

    const box = screen.getByLabelText('Message #platform');
    expect(box.tagName).toBe('TEXTAREA');
    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(calls.some((c) => c.url.endsWith('/api/org/post'))).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/org/post'))).toBe(true));
    height.mockRestore();
  });

  it('shows a channel from the URL with kind chips, task links and folded replies, and marks it read', async () => {
    const calls = mount('/org?channel=platform');
    await screen.findByText('shipped: the board');
    expect(screen.getByText('stand-up')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'task t_abc123' }).getAttribute('href')).toBe('/agents/board/t_abc123');
    expect(screen.queryByText('good')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'show 1 reply' }));
    expect(screen.getByText('good')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/org/channels/platform/read'))).toBe(true));
  });

  it('searches the board from the channel header', async () => {
    mount('/org');
    await screen.findByText('Morning all');
    fireEvent.change(screen.getByLabelText('Search messages'), { target: { value: 'tests' } });
    await screen.findByText('1 matches for "tests"');
    expect(screen.getByText('tests 29/29')).toBeTruthy();
  });

  it('draws the org chart by team with wake budgets', async () => {
    mount('/org/chart');
    await screen.findByText('Platform & Agents');
    expect(screen.getByText('Head of Platform')).toBeTruthy();
    expect(screen.getAllByText(/1\/6 wakes today/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /rune/ }).getAttribute('href')).toBe('/org/agents/rune');
  });

  it('renders an agent page with inbox, runs, memory and a DM box', async () => {
    const calls = mount('/org/agents/atlas');
    await screen.findByText('Head of Platform');
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(rows.some((t) => /owner 5 · waiting/.test(t))).toBe(true);
    expect(rows.some((t) => /routine daily-standup · done · org-atlas-1/.test(t))).toBe(true);
    expect(screen.getByText('posted the stand-up')).toBeTruthy();
    expect(screen.getByText('learned the board', { exact: false })).toBeTruthy();
    // The persona memory: its lines, the episode behind them, and the proposal card it filed.
    expect(screen.getByText('Memory (2 active lines, budget 1500 tokens)')).toBeTruthy();
    expect(rows.some((t) => /m-3 · lesson · ×2 I post the stand-up/.test(t))).toBe(true);
    expect(rows.some((t) => /request changes · corrected · 14 turns · \$0\.4200/.test(t))).toBe(true);
    expect(screen.getByRole('link', { name: 'self-improvement: atlas, I get sent back when a review card has no PR link.' }).getAttribute('href')).toBe('/board/t_prop001');
    // Cards come from the link rows even when the kanban (agent-hub) is unreachable, with their project and feature.
    expect(screen.getByRole('link', { name: 'Wire the tasks route' }).getAttribute('href')).toBe('/board/t_abc123');
    expect(screen.getByRole('link', { name: 'secondbrain-app/org-page' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('DM atlas'), { target: { value: 'hold the deploy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/org/dm'))).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/api/org/dm'))!.init?.body))).toEqual({ to: 'atlas', body: 'hold the deploy' });
  });

  it('renders an agent page from a server that predates the persona memory', async () => {
    const { core, core_path, memory_rows, episodes, proposals, memory_stats, memory_config, ...older } = AGENT_PAGE;
    void core; void core_path; void memory_rows; void episodes; void proposals; void memory_stats; void memory_config;
    mount('/org/agents/atlas', { agentPage: older });
    await screen.findByText('Head of Platform');
    expect(screen.getByText('Memory (0 active lines)')).toBeTruthy();
    expect(screen.getByText('No finished wakes recorded yet.')).toBeTruthy();
  });

  it('gives a bot a card from its page: one card, one bot, one project', async () => {
    const calls = mount('/org/agents/atlas');
    await screen.findByText('Head of Platform');
    const give = screen.getByRole('button', { name: 'Give card' }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText('Card for atlas'), { target: { value: 'Ship it' } });
    expect(give.disabled).toBe(false); // a project is optional on the engine's board
    await waitFor(() => expect(screen.getByRole('option', { name: 'secondbrain-app' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'secondbrain-app' } });
    fireEvent.change(screen.getByLabelText('Feature'), { target: { value: 'org-page' } });
    fireEvent.click(give);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/api/board/cards') && c.init?.method === 'POST')).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/api/board/cards') && c.init?.method === 'POST')!.init?.body))).toEqual({ title: 'Ship it', assignee: 'atlas', project: 'secondbrain-app', feature: 'org-page' });
    expect(await screen.findByText('card t_new000 created')).toBeTruthy();
  });

  it('live view shows every channel; kiosk mode strips the chrome', async () => {
    mount('/org/live');
    await screen.findByText('Morning all');
    expect(screen.getAllByRole('link', { name: '#platform' }).length).toBe(2); // the reply is folded under its root
    cleanup();
    mount('/org/live?kiosk=1');
    await screen.findByTestId('kiosk');
    expect(screen.getByText('Argo · company board')).toBeTruthy();
  });
});
