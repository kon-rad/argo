import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Usage from '../src/routes/usage/Usage.js';
import UsageSession from '../src/routes/usage/UsageSession.js';
import { sessionName } from '../src/routes/usage/AgentSessions.js';
import { bucketEnd, contextLabel, personaLabel } from '../src/routes/usage/format.js';
import { appTimezone, browserTimezone, setAppTimezone, shortStamp, span, startedStamp, zoned } from '../src/lib/time.js';

// Sessions as an inspection tool: Started as YYYYMMDD HH:mm in the shared zone, duration apart from it, type and
// bot persona columns with bookmarkable filters, context told apart from token totals. All data is made up.

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setAppTimezone(null); });

describe('time helpers in the shared zone', () => {
  it('Started is YYYYMMDD HH:mm, 24-hour, in the given zone, across date lines', () => {
    const iso = '2026-11-09T23:30:00Z';
    expect(startedStamp(iso, 'UTC')).toBe('20261109 23:30');
    expect(startedStamp(iso, 'Asia/Singapore')).toBe('20261110 07:30');      // the next day
    expect(startedStamp(iso, 'America/Los_Angeles')).toBe('20261109 15:30');
    expect(startedStamp('2026-11-10T16:00:00Z', 'Asia/Singapore')).toBe('20261111 00:00'); // midnight is 00, not 24
    expect(startedStamp(null, 'UTC')).toBe('');
  });

  it('handles the DST change: the repeated hour keeps its true offset', () => {
    // US clocks fall back at 02:00 PDT on 2026-11-01: 08:30Z and 09:30Z are both 01:30 local.
    expect(startedStamp('2026-11-01T08:30:00Z', 'America/Los_Angeles')).toBe('20261101 01:30');
    expect(startedStamp('2026-11-01T09:30:00Z', 'America/Los_Angeles')).toBe('20261101 01:30');
    expect(startedStamp('2026-03-08T10:30:00Z', 'America/Los_Angeles')).toBe('20260308 03:30'); // spring forward skips 02:xx
    // Day buckets end at the next local midnight, 25 or 23 hours later.
    expect(bucketEnd('2026-11-01T07:00:00Z', 'day', 'America/Los_Angeles')).toBe('2026-11-02T08:00:00.000Z');
    expect(bucketEnd('2026-03-08T08:00:00Z', 'day', 'America/Los_Angeles')).toBe('2026-03-09T07:00:00.000Z');
    expect(bucketEnd('2026-11-09T16:00:00Z', 'day', 'Asia/Singapore')).toBe('2026-11-10T16:00:00.000Z');
  });

  it('the vault zone drives the default; an invalid or missing one falls back to the browser', () => {
    expect(setAppTimezone('Asia/Singapore')).toBe('Asia/Singapore');
    expect(startedStamp('2026-11-09T23:30:00Z')).toBe('20261110 07:30');
    expect(zoned('2026-11-09T23:30:00Z')).toMatch(/Nov 10, 2026/);
    expect(setAppTimezone('Mars/Olympus')).toBe(browserTimezone());
    expect(setAppTimezone(null)).toBe(browserTimezone());
    expect(appTimezone()).toBe(browserTimezone());
  });

  it('duration is the elapsed span, shown apart from Started; unknown when an end is missing', () => {
    expect(span('2026-11-10T07:13:00Z', '2026-11-10T07:13:40Z')).toBe('40 s');
    expect(span('2026-11-10T07:13:00Z', '2026-11-10T07:43:00Z')).toBe('30 min');
    expect(span('2026-11-10T07:13:00Z', '2026-11-10T09:18:00Z')).toBe('2 h 05 min');
    expect(span('2026-11-10T07:13:00Z', '2026-11-12T11:13:00Z')).toBe('2 d 4 h');
    expect(span('2026-11-10T07:13:00Z', null)).toBeNull();
  });
});

describe('session cells', () => {
  it('names a skill run with its start time, every name one line under 100 characters', () => {
    expect(sessionName({ display_title: 'daily-update', title_source: 'skill', started_at: '2026-11-10T07:13:00Z' }, 'UTC'))
      .toBe('daily-update · Nov 10 07:13');
    expect(shortStamp('2026-11-09T23:30:00Z', 'Asia/Singapore')).toBe('Nov 10 07:30');
    expect(sessionName({ display_title: 'Fix the page', title_source: 'prompt', started_at: '2026-11-10T07:13:00Z' }, 'UTC')).toBe('Fix the page');
    const long = sessionName({ display_title: 's'.repeat(98), title_source: 'skill', started_at: '2026-11-10T07:13:00Z' }, 'UTC')!;
    expect(long.length).toBeLessThan(100);
    expect(long.endsWith('Nov 10 07:13')).toBe(true);
    expect(sessionName({ display_title: null, title_source: null, started_at: null }, 'UTC')).toBeNull();
  });

  it('persona and context say when they are not recorded', () => {
    expect(personaLabel({ persona: 'sol', session_type: 'telegram' })).toEqual({ text: 'sol', known: true });
    expect(personaLabel({ persona: null, session_type: 'cli' })).toEqual({ text: 'none', known: false });
    expect(personaLabel({ persona: null, session_type: 'headless' })).toEqual({ text: 'unknown', known: false });
    expect(contextLabel({ context_tokens: 30150, context_window: null })).toBe('30.1k / ?');
    expect(contextLabel({ context_tokens: null, context_window: 128000 })).toBe('? / 128.0k');
    expect(contextLabel({ context_tokens: null, context_window: null })).toBeNull();
  });
});

const row = (o: Record<string, unknown>) => ({ id: 1, source: 'claude-code', harness: 'claude-code', profile: null, provider: 'anthropic', host: 'droplet',
  external_id: 'x', parent_external_id: null, project: null, title: null, first_prompt: null, started_at: null, ended_at: null, channel: null, channel_bot: null,
  steps: 0, tool_calls: 0, errors: 0, subagents: 0, models: [], calls: 0, input: 0, cache_write: 0, cache_read: 0, output: 0, reasoning: 0,
  session_type: 'unknown', persona: null, display_title: null, title_source: null, context_tokens: null, context_at: null, context_window: null, ...o });
const SESSIONS = { total: 2, sessions: [
  row({ id: 1, external_id: 'tg', channel: 'telegram', channel_bot: 'claude', session_type: 'telegram', persona: 'claude',
    display_title: 'what is on the board?', title_source: 'prompt', started_at: '2026-11-09T23:30:00Z', ended_at: '2026-11-10T00:00:00Z',
    models: ['claude-opus-5-5'], calls: 2, input: 1055, cache_read: 59000, output: 30, context_tokens: 30150, context_at: '2026-11-10T00:00:00Z' }),
  row({ id: 2, external_id: 'daily', host: 'mac', session_type: 'headless', display_title: 'daily-update', title_source: 'skill',
    started_at: '2026-11-09T23:13:00Z', ended_at: null }),
] };
const FACETS = { facets: { harness: [{ value: 'claude-code', n: 2 }], host: [{ value: 'droplet', n: 1 }, { value: 'mac', n: 1 }], profile: [], provider: [], channel: [],
  type: [{ value: 'headless', n: 1 }, { value: 'telegram', n: 1 }], persona: [{ value: 'claude', n: 1 }, { value: 'unknown', n: 1 }], tool: [] } };
const CONFIG = { subscriptions: [], credits: [], sections: ['ledger', 'sessions'] };

function mockFetch(meta: Record<string, unknown>) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    const body = u.includes('/api/meta') ? { modules: ['usage'], ...meta } : u.includes('/usage/config') ? CONFIG
      : u.includes('/usage/agent-sessions/facets') ? FACETS : u.includes('/usage/agent-sessions') ? SESSIONS
      : u.includes('/usage/series') ? { bucket: 'hour', tz: 'UTC', rows: [] } : u.includes('/usage/facets') ? { total: { calls: 0, tokens: 0 }, facets: {} }
      : u.includes('/usage/runs') ? { runs: [] } : u.includes('/usage/org-wakes') ? { agents: [] } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return () => fn.mock.calls.map((c) => String(c[0]));
}

const page = (path: string) => render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={[path]}><Usage /></MemoryRouter></QueryClientProvider>);

describe('Sessions list', () => {
  it('shows Started, Duration, Machine, Type and Bot persona in the vault zone, with context apart from totals', async () => {
    mockFetch({ timezone: 'Asia/Singapore' });
    page('/usage?view=sessions');
    const link = await screen.findByRole('link', { name: 'what is on the board?' });
    const tr = link.closest('tr')!;
    await waitFor(() => expect(within(tr).getByText('20261110 07:30')).toBeTruthy());
    for (const h of ['Started', 'Duration', 'Machine', 'Type', 'Bot persona', 'Session', 'Context']) expect(screen.getByRole('columnheader', { name: h })).toBeTruthy();
    expect(within(tr).getByText('30 min')).toBeTruthy();
    expect(within(tr).getByText('telegram')).toBeTruthy();
    expect(within(tr).getByText('claude')).toBeTruthy();
    expect(within(tr).getByText('30.1k / ?')).toBeTruthy();       // latest call over an unknown window
    expect(within(tr).getByText('1055 / 30')).toBeTruthy();       // totals stay their own column
    // The skill run carries its local start; no end means no duration, said with a dash.
    expect(screen.getByRole('link', { name: 'daily-update · Nov 10 07:13' })).toBeTruthy();
    const daily = screen.getByRole('link', { name: 'daily-update · Nov 10 07:13' }).closest('tr')!;
    expect(within(daily).getByText('unknown')).toBeTruthy(); // persona not recorded
    expect(within(daily).getAllByText('-').length).toBeGreaterThan(0);
  });

  it('type and persona filters come from the URL, go to the API and toggle from the chips', async () => {
    const calls = mockFetch({});
    page('/usage?view=sessions&s_type=telegram&s_persona=claude&s_host=droplet');
    await screen.findByRole('link', { name: 'what is on the board?' });
    await waitFor(() => expect(calls().some((u) => u.includes('/usage/agent-sessions?') && u.includes('type=telegram')
      && u.includes('persona=claude') && u.includes('host=droplet'))).toBe(true));
    expect(screen.getByRole('button', { name: 'telegram' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'headless' }));
    await waitFor(() => expect(calls().some((u) => u.includes('type=telegram%2Cheadless') || u.includes('type=telegram,headless'))).toBe(true));
    expect(screen.getByText('bot persona')).toBeTruthy();
  });

  it('buckets the ledger in the vault zone and says where the zone came from', async () => {
    const calls = mockFetch({ timezone: 'Asia/Singapore' });
    page('/usage?view=ledger');
    await waitFor(() => expect(calls().some((u) => u.includes('/usage/series') && u.includes('tz=Asia%2FSingapore'))).toBe(true));
    expect(await screen.findByText(/time zone Asia\/Singapore \(vault setting\)/)).toBeTruthy();
  });

  it('without a vault zone the browser zone is used, never the server', async () => {
    const calls = mockFetch({ timezone: null });
    page('/usage?view=ledger');
    await waitFor(() => expect(calls().some((u) => u.includes('/usage/series') && u.includes(`tz=${encodeURIComponent(browserTimezone())}`))).toBe(true));
    expect(await screen.findByText(/\(this browser\)/)).toBeTruthy();
  });
});

describe('Session page', () => {
  it('shows type, persona, model, provider, Started, Duration, totals and context with unknowns said', async () => {
    const s = SESSIONS.sessions[0]!;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      const body = u.includes('/api/meta') ? { modules: ['usage'], timezone: 'America/Los_Angeles' } : { session: s, runs: [], steps: [], next: null };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/usage/session/droplet/tg?source=claude-code']}>
      <Routes><Route path="/usage/session/:host/:externalId" element={<UsageSession />} /></Routes></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('heading', { name: 'what is on the board?' })).toBeTruthy();
    const dl = screen.getByLabelText('Session summary');
    await waitFor(() => expect(within(dl).getByText('20261109 15:30 (America/Los_Angeles)')).toBeTruthy());
    expect(within(dl).getByText('30 min')).toBeTruthy();
    expect(within(dl).getByText('telegram')).toBeTruthy();
    expect(within(dl).getByText('claude')).toBeTruthy();
    expect(within(dl).getByText('claude-opus-5-5 via anthropic')).toBeTruthy();
    expect(within(dl).getByText(/30\.1k \/ \? at the latest call \(16:00:00\)/)).toBeTruthy();
    expect(within(dl).getByText(/capacity unknown/)).toBeTruthy();
    expect(within(dl).getByText(/in 1055 · cache r 59.0k · out 30/)).toBeTruthy();
  });
});
