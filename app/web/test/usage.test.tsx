import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Usage from '../src/routes/usage/Usage.js';
import { bucketEnd, formatTokens, money } from '../src/routes/usage/format.js';

const PLAN = { current: {
  five_hour: { used_pct: null, left_pct: null, resets_at: '2026-10-14T01:00:00Z', observed_at: '2026-10-13T22:00:00Z', host: 'mac', origin: 'statusline', reset_since_reading: true, last_pct: 92 },
  seven_day: { used_pct: 41.2, left_pct: 58.8, resets_at: '2099-01-01T00:00:00Z', observed_at: '2026-10-14T00:00:00Z', host: 'mac', origin: 'statusline', reset_since_reading: false, last_pct: 41.2 } },
  history: [] };
const CONFIG = { subscriptions: ['claude-code'], credits: [], sections: ['ledger', 'sessions', 'running', 'summaries'] };
const SUBSCRIPTIONS = { providers: [{ provider: 'claude-code', label: 'Claude Code', status: 'ok', observed_at: '2026-10-14T00:00:00Z', source: 'statusline', message: null, stale: false,
  windows: [{ key: 'seven_day', label: '7-day window', window_minutes: 10080, used_pct: 41.2, left_pct: 58.8, resets_at: '2099-01-01T00:00:00Z', observed_at: '2026-10-14T00:00:00Z', reset_since_reading: false, last_pct: 41.2 },
    { key: 'five_hour', label: '5-hour window', window_minutes: 300, used_pct: null, left_pct: null, resets_at: '2026-10-14T01:00:00Z', observed_at: '2026-10-13T22:00:00Z', reset_since_reading: true, last_pct: 92 }] }] };
const SERIES = { bucket: 'hour', tz: 'UTC', rows: [
  { bucket: '2026-10-14T01:00:00.000Z', key: 'all', input: 10, cache_write: 100, cache_read: 1000, output: 50, calls: 1 }] };
const row = (o: Record<string, unknown>) => ({ id: 1, source: 'claude-code', harness: 'claude-code', profile: null, provider: 'anthropic', host: 'droplet',
  external_id: 'x', parent_external_id: null, project: null, title: null, first_prompt: null, started_at: null, ended_at: null,
  steps: 0, tool_calls: 0, errors: 0, subagents: 0, models: [], calls: 0, input: 0, cache_write: 0, cache_read: 0, output: 0, reasoning: 0, ...o });
const SESSIONS = { total: 3, sessions: [
  row({ id: 1, external_id: 'cc1', task_ids: ['t_1234abcd'], title: 'Fix dispatcher', display_title: 'Fix dispatcher', title_source: 'title', started_at: '2026-10-14T01:00:00Z', ended_at: '2026-10-14T01:05:00Z',
    calls: 9, input: 10, cache_write: 100, cache_read: 1000, output: 50, steps: 12, tool_calls: 4, errors: 1, models: ['claude-opus-5-5'] }),
  row({ id: 2, host: 'mac', external_id: 'arch-only-session' }),
  row({ id: 3, source: 'hermes', harness: 'hermes', profile: 'main', provider: 'openrouter', external_id: 'h1', title: 'Hermes chat', display_title: 'Hermes chat', title_source: 'title',
    started_at: '2026-10-14T01:00:00Z', calls: 2, input: 5, output: 5, cost_usd: 0.42, models: ['deepseek-v4-flash'] })] };
const AFACETS = { facets: { harness: [{ value: 'claude-code', n: 2 }, { value: 'hermes', n: 1 }], host: [{ value: 'droplet', n: 2 }, { value: 'mac', n: 1 }],
  profile: [], provider: [], tool: [{ value: 'Bash', n: 4 }] } };
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
    const body = u.includes('/usage/config') ? CONFIG : u.includes('/usage/subscriptions') ? SUBSCRIPTIONS : u.includes('/usage/plan') ? PLAN : u.includes('/usage/series') ? seriesBody
      : u.includes('/usage/agent-sessions/facets') ? AFACETS : u.includes('/usage/agent-sessions') ? SESSIONS : u.includes('/usage/runs') ? RUNS
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
  it('writes explicit currency for credit balances', () => {
    expect(money(7.9394, 'USD')).toBe('$7.94');
    expect(money(12, 'EUR')).toBe('12.00 EUR');
    expect(money(null, 'USD')).toBe('-');
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
  it('uses the vault zone for credit and subscription timestamps and browser fallback after clearing it', async () => {
    const first = '2026-11-10T23:30:00Z';
    const latest = '2026-11-10T23:45:00Z';
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const date = (iso: string, timeZone: string) => new Date(iso).toLocaleDateString([], { timeZone });
    const datetime = (iso: string, timeZone: string) => new Date(iso).toLocaleString([], { timeZone });
    // Pick opposite sides of midnight regardless of the test machine's own zone.
    let configured: string | null = date(first, browserZone) === date(first, 'Asia/Tokyo')
      ? 'Pacific/Honolulu' : 'Asia/Tokyo';
    const vaultZone = configured;
    expect(date(first, vaultZone)).not.toBe(date(first, browserZone));
    const reading = { provider: 'openrouter', observed_at: latest, status: 'ok', origin: 'api', balance: 8,
      currency: 'USD', total_credits: null, total_usage: null, note: null };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      const body = u.includes('/usage/config') ? { subscriptions: ['claude-code'], credits: ['openrouter'], sections: [] }
        : u.includes('/usage/credits') ? { providers: [{ provider: 'openrouter', latest: reading, last_ok: reading }], history: [
          { provider: 'openrouter', observed_at: first, balance: 10, currency: 'USD' },
          { provider: 'openrouter', observed_at: latest, balance: 8, currency: 'USD' }] }
          : u.includes('/usage/subscriptions') ? { providers: [{ ...SUBSCRIPTIONS.providers[0], observed_at: latest,
            windows: [{ ...SUBSCRIPTIONS.providers[0]!.windows[0], resets_at: first, observed_at: latest }] }] }
            : u.includes('/meta') ? { timezone: configured, modules: [] } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter><Usage /></MemoryRouter></QueryClientProvider>);
    await screen.findByText(/spent since/);
    expect.soft(screen.getByText(/spent since/).textContent).toBe(`$2.00 spent since ${date(first, vaultZone)}`);
    expect.soft(screen.getByText(/^as of /).textContent).toBe(`as of ${datetime(latest, vaultZone)} (API)`);
    await screen.findByText(/^Window observed /);
    expect.soft(screen.getByText(/^Resets /).textContent?.startsWith(`Resets ${datetime(first, vaultZone)}`)).toBe(true);
    expect.soft(screen.getByText(/^Window observed /).textContent).toBe(`Window observed ${datetime(latest, vaultZone)}`);
    expect.soft(screen.getByText(/^Source: /).textContent).toBe(`Source: statusline · observed ${datetime(latest, vaultZone)}`);

    configured = null;
    await client.invalidateQueries({ queryKey: ['meta'] });
    await waitFor(() => {
      expect(screen.getByText(/spent since/).textContent).toBe(`$2.00 spent since ${date(first, browserZone)}`);
      expect(screen.getByText(/^as of /).textContent).toBe(`as of ${datetime(latest, browserZone)} (API)`);
      expect(screen.getByText(/^Resets /).textContent?.startsWith(`Resets ${datetime(first, browserZone)}`)).toBe(true);
      expect(screen.getByText(/^Window observed /).textContent).toBe(`Window observed ${datetime(latest, browserZone)}`);
      expect(screen.getByText(/^Source: /).textContent).toBe(`Source: statusline · observed ${datetime(latest, browserZone)}`);
    });
    client.clear();
  });

  it('requests sessions for the clicked bucket', async () => {
    mockFetch();
    const { container } = render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Usage /></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(container.querySelector('g[style*="cursor"]')).toBeTruthy());
    fireEvent.click(container.querySelector('g[style*="cursor"]')!);
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));
    await waitFor(() => expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => {
      const u = String(c[0]);
      return u.includes('/usage/agent-sessions?') && u.includes('from=2026-10-14T01%3A00%3A00.000Z') && u.includes('to=2026-10-14T02%3A00%3A00.000Z');
    })).toBe(true));
  });
  it.each([[[]], [[{ bucket: '2026-10-14T01:00:00.000Z', key: 'all', input: 0, cache_write: 0, cache_read: 0, output: 0, calls: 0 }]]])(
    'renders empty and all-zero series without throwing', async (rows) => {
      seriesBody = { bucket: 'hour', tz: 'UTC', rows };
      mockFetch();
      render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Usage /></MemoryRouter></QueryClientProvider>);
      fireEvent.click(await screen.findByRole('tab', { name: 'Sessions' }));
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
      const body = u.includes('/usage/config') ? CONFIG : u.includes('/usage/subscriptions') ? SUBSCRIPTIONS : u.includes('/usage/plan') ? PLAN : u.includes('/usage/series') ? SERIES
        : u.includes('/usage/agent-sessions/facets') ? AFACETS : u.includes('/usage/agent-sessions') ? SESSIONS
        : u.includes('/usage/runs') ? RUNS2 : u.includes('/usage/facets') ? FACETS : u.includes('/usage/org-wakes') ? { agents: [] } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Usage /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('link', { name: 'atlas' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'atlas' }).getAttribute('href')).toBe('/org/agents/atlas');
    expect(screen.getByRole('link', { name: 't_9' }).getAttribute('href')).toBe('/board/t_9');
    expect(screen.getByRole('button', { name: 'mention' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'secondbrain-app' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'coding' })).toBeTruthy();
    expect(screen.getByText('1070')).toBeTruthy();                       // 10 + 0 + 1000 + 60 tokens for the run
    expect(document.body.textContent).not.toContain('$');
  });

  it('shows subscription cards, the sessions table and a failed verify', async () => {
    mockFetch();
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><Usage /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('tab', { name: 'Account' }));
    await waitFor(() => expect(screen.getByText('58.8% remaining')).toBeTruthy());
    expect(screen.getByText(/Last reading: 92% used/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));
    expect(await screen.findByRole('link', { name: 'Fix dispatcher' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Ticket' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 't_1234abcd' }).getAttribute('href')).toBe('/board/t_1234abcd');
    expect(screen.getByRole('link', { name: 'Fix dispatcher' }).getAttribute('href')).toBe('/usage/session/droplet/cc1?source=claude-code');
    expect(screen.getByRole('link', { name: 'arch-only-se' })).toBeTruthy();   // null surface/started_at render blank, no crash
    fireEvent.click(screen.getByRole('tab', { name: 'Ledger' }));
    expect(await screen.findByText(/failed.*901/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain('$');
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));
    expect(screen.getAllByText('0.42 USD')).toHaveLength(1);
    // The list's own filters: a harness chip adds s_harness to the request.
    fireEvent.click(screen.getByRole('button', { name: 'hermes' }));
    await waitFor(() => expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => String(c[0]).includes('/usage/agent-sessions?') && String(c[0]).includes('harness=hermes'))).toBe(true));
    fireEvent.click(screen.getByRole('tab', { name: 'Ledger' }));
    fireEvent.click(screen.getByRole('button', { name: '90 d' }));     // over 31 days: hourly buckets switch off
    await waitFor(() => expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => String(c[0]).includes('bucket=day'))).toBe(true));
  });
});
