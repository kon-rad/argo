import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Usage from '../src/routes/usage/Usage.js';
import { bucketEnd, formatTokens, planText } from '../src/routes/usage/format.js';

const PLAN = { current: {
  five_hour: { used_pct: null, left_pct: null, resets_at: '2026-10-14T01:00:00Z', observed_at: '2026-10-13T22:00:00Z', host: 'mac', origin: 'statusline', reset_since_reading: true, last_pct: 92 },
  seven_day: { used_pct: 41.2, left_pct: 58.8, resets_at: '2099-01-01T00:00:00Z', observed_at: '2026-10-14T00:00:00Z', host: 'mac', origin: 'statusline', reset_since_reading: false, last_pct: 41.2 } },
  history: [] };
const SERIES = { bucket: 'hour', tz: 'UTC', rows: [
  { bucket: '2026-10-14T01:00:00.000Z', key: 'all', input: 10, cache_write: 100, cache_read: 1000, output: 50, calls: 1 }] };
const SESSIONS = { sessions: [{ source: 'claude-code', host: 'droplet', external_id: 'cc1', title: 'Fix dispatcher', surface: 'cc-lane',
  started_at: '2026-10-14T01:00:00Z', ended_at: '2026-10-14T01:05:00Z', calls: 9, input: 10, cache_write: 100, cache_read: 1000,
  output: 50, cost_usd: null, task_id: 't_9', lane: 'cc-coder', archive_id: 3 },
  { source: 'claude-code', host: 'mac', external_id: 'arch-only-session', title: null, surface: null,
  started_at: null, ended_at: null, calls: 0, input: 0, cache_write: 0, cache_read: 0,
  output: 0, cost_usd: null, task_id: null, lane: null, archive_id: 4 },
  { source: 'hermes', host: 'droplet', external_id: 'h1', title: 'Hermes chat', surface: 'telegram',
  started_at: '2026-10-14T01:00:00Z', ended_at: null, calls: 2, input: 5, cache_write: 0, cache_read: 0,
  output: 5, cost_usd: 0.42, task_id: null, lane: null, archive_id: null }] };
const RUNS = { runs: [{ host: 'droplet', session_id: 'cc1', task_id: 't_9', lane: 'cc-coder', board: 'exo', model: 'claude-opus-5-5',
  started_at: '2026-10-14T01:00:00Z', ended_at: '2026-10-14T01:05:00Z', duration_ms: 300000, num_turns: 9, subtype: 'success',
  is_error: false, verify_name: 'argo-exo-tests', verify_passed: false, verify_exit: 1, verify_metric: 901, verify_output: '4 failed' }] };

const FACETS = { from: '', to: '', total: { calls: 10, tokens: 1160 }, facets: {
  agent: [{ value: 'atlas', calls: 6, tokens: 900, output: 60 }, { value: 'unlabelled', calls: 4, tokens: 260, output: 20 }],
  action: [{ value: 'post', calls: 5, tokens: 700, output: 50 }, { value: 'reply', calls: 5, tokens: 460, output: 30 }],
  team: [], reason: [], work_type: [], project: [], feature: [], task: [], host: [{ value: 'droplet', calls: 10, tokens: 1160, output: 80 }], headless: [], surface: [], lane: [], model: [], source: [] } };
const RUNS2 = { runs: [{ ...RUNS.runs[0], run_id: 'org-atlas-20261014-010000', agent_name: 'atlas', team_slug: 'platform', reason: 'mention', work_type: 'coding',
  project_slug: 'secondbrain-app', feature_slug: null, card_title: 'Fix it', resumed: true, surface: 'bot', calls: 2, input: 10, cache_write: 0, cache_read: 1000, output: 60, lane: null, verify_name: null }] };
let seriesBody: unknown = SERIES;
function mockFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    const body = u.includes('/usage/plan') ? PLAN : u.includes('/usage/series') ? seriesBody
      : u.includes('/usage/sessions') ? SESSIONS : u.includes('/usage/runs') ? RUNS
      : u.includes('/usage/org-wakes') ? { agents: [{ agent_name: 'atlas', team_slug: 'platform', role: 'Head', wakes: 3, done: 2, open: 1, routine: 1, dm: 1, mention: 1, task: 1, tokens: 5000, avg_minutes: 1.2, last_wake: '2026-10-14T01:00:00Z' }] }
      : u.includes('/usage/facets') ? FACETS : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

afterEach(() => { seriesBody = SERIES; cleanup(); vi.unstubAllGlobals(); });

describe('format', () => {
  it('formats token counts', () => {
    expect([formatTokens(812), formatTokens(34_512), formatTokens(1_234_567)]).toEqual(['812', '34.5k', '1.2M']);
  });
  it('never shows a stale reading as current', () => {
    expect(planText(PLAN.current.five_hour).main).toMatch(/reset/i);
    expect(planText(PLAN.current.seven_day).main).toBe('58.8% left');
    expect(planText(null).main).toMatch(/no reading/i);
    const lapsed = { ...PLAN.current.seven_day, resets_at: '2020-01-01T00:00:00Z' };
    expect(planText(lapsed).main).toBe(planText(PLAN.current.five_hour).main);
  });
});

describe('bucketEnd', () => {
  it('handles hours and DST-length days', () => {
    expect(bucketEnd('2026-10-14T01:00:00.000Z', 'hour', 'UTC')).toBe('2026-10-14T02:00:00.000Z');
    expect(bucketEnd('2026-11-01T05:00:00Z', 'day', 'America/Chicago')).toBe('2026-11-02T06:00:00.000Z');
    expect(bucketEnd('2026-03-08T06:00:00Z', 'day', 'America/Chicago')).toBe('2026-03-09T05:00:00.000Z');
    expect(bucketEnd('2026-10-13T15:00:00Z', 'day', 'Asia/Tokyo')).toBe('2026-10-14T15:00:00.000Z');
  });
});

describe('Usage page', () => {
  it('requests sessions for the clicked bucket', async () => {
    mockFetch();
    const { container } = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Usage /></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(container.querySelector('g[style*="cursor"]')).toBeTruthy());
    fireEvent.click(container.querySelector('g[style*="cursor"]')!);
    await waitFor(() => expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => {
      const u = String(c[0]);
      return u.includes('/usage/sessions') && u.includes('from=2026-10-14T01%3A00%3A00.000Z') && u.includes('to=2026-10-14T02%3A00%3A00.000Z');
    })).toBe(true));
  });
  it.each([[[]], [[{ bucket: '2026-10-14T01:00:00.000Z', key: 'all', input: 0, cache_write: 0, cache_read: 0, output: 0, calls: 0 }]]])(
    'renders empty and all-zero series without throwing', async (rows) => {
      seriesBody = { bucket: 'hour', tz: 'UTC', rows };
      mockFetch();
      render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Usage /></MemoryRouter></QueryClientProvider>);
      expect(await screen.findByRole('link', { name: 'Fix dispatcher' })).toBeTruthy();
    });

  it('reads filters from the URL, sends them to every endpoint, and a legend click adds one', async () => {
    seriesBody = { bucket: 'hour', tz: 'UTC', rows: [
      { bucket: '2026-10-14T01:00:00.000Z', key: 'post', input: 10, cache_write: 0, cache_read: 600, output: 50, calls: 5 },
      { bucket: '2026-10-14T01:00:00.000Z', key: 'reply', input: 10, cache_write: 0, cache_read: 400, output: 30, calls: 5 }] };
    mockFetch();
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/usage?days=7&agent=atlas&group=action']}><Usage /></MemoryRouter></QueryClientProvider>);
    const calls = () => (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    await waitFor(() => expect(calls().some((u) => u.includes('/usage/series') && u.includes('agent=atlas') && u.includes('group=action') && u.includes('days') === false)).toBe(true));
    expect(calls().some((u) => u.includes('/usage/runs') && u.includes('agent=atlas'))).toBe(true);
    expect(calls().some((u) => u.includes('/usage/facets') && u.includes('agent=atlas'))).toBe(true);
    expect(await screen.findByRole('button', { name: 'Remove filter bot atlas' })).toBeTruthy();
    // The breakdown table for the grouped dimension, with shares of the total.
    expect(await screen.findByText('Tokens by action')).toBeTruthy();
    expect(screen.getByText('60%')).toBeTruthy();
    // A legend entry adds its value as a filter, ORed with the dimension's other values.
    fireEvent.click(screen.getAllByRole('button', { name: /^post$/ })[0]!);    // the legend; the breakdown row is the other
    await waitFor(() => expect(calls().some((u) => u.includes('/usage/series') && u.includes('action=post'))).toBe(true));
    expect(screen.getByRole('button', { name: 'Remove filter action post' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter bot atlas' }));
    await waitFor(() => expect(calls().some((u) => u.includes('/usage/series') && u.includes('action=post') && !u.includes('agent='))).toBe(true));
  });

  it('shows a bot\'s run with who, why, card, project, work and tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      const body = u.includes('/usage/plan') ? PLAN : u.includes('/usage/series') ? SERIES : u.includes('/usage/sessions') ? SESSIONS
        : u.includes('/usage/runs') ? RUNS2 : u.includes('/usage/facets') ? FACETS : u.includes('/usage/org-wakes') ? { agents: [] } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Usage /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('link', { name: 'atlas' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'atlas' }).getAttribute('href')).toBe('/org/agents/atlas');
    expect(screen.getByRole('link', { name: 't_9' }).getAttribute('href')).toBe('/agents/board/t_9');
    expect(screen.getByRole('button', { name: 'mention' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'secondbrain-app' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'coding' })).toBeTruthy();
    expect(screen.getByText('1070')).toBeTruthy();                       // 10 + 0 + 1000 + 60 tokens for the run
    expect(document.body.textContent!.match(/\$/g)).toHaveLength(1);    // still only the Hermes session shows dollars
  });

  it('shows plan cards, the sessions table and a failed verify', async () => {
    mockFetch();
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Usage /></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('58.8% left')).toBeTruthy());
    expect(screen.getByText(/was 92% used/)).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Fix dispatcher' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Fix dispatcher' }).getAttribute('href')).toBe('/usage/session/droplet/cc1?source=claude-code');
    expect(screen.getByRole('link', { name: 'arch-only-se' })).toBeTruthy();   // null surface/started_at render blank, no crash
    expect(screen.getByText(/failed.*901/i)).toBeTruthy();
    expect(document.body.textContent!.match(/\$/g)).toHaveLength(1);              // only the Hermes row shows dollars
    expect(screen.getAllByText('$0.42')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '90 d' }));     // over 31 days: hourly buckets switch off
    await waitFor(() => expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => String(c[0]).includes('bucket=day'))).toBe(true));
  });
});
