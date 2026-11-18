import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Usage from '../src/routes/usage/Usage.js';
import Running, { elapsedText } from '../src/routes/usage/Running.js';
import { browserTimezone } from '../src/lib/time.js';

const row = (o: Record<string, unknown>) => ({ kind: 'bot', name: 'atlas', runtime: 'claude-code', model: 'opus', pid: 100, user: 'agent', elapsedSec: 192,
  startedAt: '2026-10-26T12:00:00Z', runId: 'atlas-1', reason: 'task', ref: 't_9', state: 'running', configured: { runtime: 'claude-code', model: 'opus' }, detail: null, ...o });
const RUNNING = { host: 'server-1', at: '2026-10-26T12:03:12Z', configured: { 'claude-code': 20, 'zen-agent': 2 }, rows: [
  row({}),
  row({ name: 'rune', runtime: 'claude-code', model: null, pid: 101, configured: { runtime: 'zen-agent', model: 'openrouter/x/y' } }),
  row({ name: 'sol', pid: null, user: null, state: 'claimed', runId: 'sol-1', detail: 'stale?' }),
  row({ kind: 'lane', name: 'cc-coder', reason: 'task', configured: null }),
  row({ kind: 'other', name: 'Remote Control server', reason: null, ref: null, runId: null, configured: null, elapsedSec: 90000 }),
] };

function mockFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/usage/config') ? { subscriptions: [], credits: [], sections: ['ledger', 'running'] }
      : url.includes('/usage/live') ? { at: RUNNING.at, total: 1, serverMachine: 'server-1', machines: [{slug: 'laptop-a', display: 'Laptop A', kind: 'laptop', agents: [{ id: 'session:laptop-a:s1', machine: 'laptop-a', harness: 'codex', name: 'native Codex', model: 'example-model', task: null, source: 'session', turns: 3, tokens: {input: 100, output: 20}, startedAt: RUNNING.at, lastActivityAt: RUNNING.at, elapsedSec: 120, log: null, pid: null, runId: null, stoppable: false }]}] } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('elapsedText', () => {
  it('reads as seconds, minutes, hours or days', () => {
    expect([elapsedText(9), elapsedText(192), elapsedText(7500), elapsedText(90000), elapsedText(null)]).toEqual(['9 s', '3 m 12 s', '2 h 05 m', '1 d 1 h', '']);
  });
});

describe('Running now tab', () => {
  it('updates the legacy read time and started tooltip in place when metadata changes', async () => {
    const instant = '2026-01-02T00:15:30Z';
    let timezone: string | null = 'America/Los_Angeles';
    const calls: string[] = [];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const clock = (tz: string) => new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).format(new Date(instant));
    const started = (tz: string) => new Intl.DateTimeFormat([], {
      timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      second: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    }).format(new Date(instant));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input), 'http://x').pathname;
      calls.push(pathname);
      return Response.json(pathname === '/api/meta' ? { timezone } : {
        host: 'server-1', at: instant, configured: {}, rows: [row({ startedAt: instant })],
      });
    }));
    const { container } = render(
      <QueryClientProvider client={client}><MemoryRouter><Running /></MemoryRouter></QueryClientProvider>,
    );
    const header = await screen.findByText(/Processes on/);
    const running = container.querySelector<HTMLElement>('td[title^="since "]')!;
    expect(header.textContent).toContain(`read ${clock(timezone)}`);
    expect(running.title).toBe(`since ${started(timezone)}`);

    let before = calls.length;
    timezone = 'Asia/Tokyo';
    await client.invalidateQueries({ queryKey: ['meta'] });
    await waitFor(() => expect(header.textContent).toContain(`read ${clock(timezone!)}`));
    expect(running.title).toBe(`since ${started(timezone)}`);
    expect(calls.slice(before)).toEqual(['/api/meta']);
    expect(screen.getByText(/Processes on/)).toBe(header);
    expect(container.querySelector('td[title^="since "]')).toBe(running);

    before = calls.length;
    timezone = null;
    await client.invalidateQueries({ queryKey: ['meta'] });
    await waitFor(() => expect(header.textContent).toContain(`read ${clock(browserTimezone())}`));
    expect(running.title).toBe(`since ${started(browserTimezone())}`);
    expect(calls.slice(before)).toEqual(['/api/meta']);
    client.clear();
  });

  it('is reached from the Usage tabs and shows native sessions from other machines', async () => {
    mockFetch();
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/usage']}><Usage /></MemoryRouter></QueryClientProvider>);
    expect((await screen.findByRole('tab', { name: 'Ledger' })).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Running now' }));
    expect(await screen.findByText('Laptop A')).toBeTruthy();
    expect(screen.getByText('native Codex')).toBeTruthy();
    expect(screen.getByText('codex')).toBeTruthy();
  });

  it('opens straight onto the tab from ?view=running', async () => {
    mockFetch();
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/usage?view=running']}><Usage /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText('Laptop A')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Running now' }).getAttribute('aria-selected')).toBe('true');
  });
});
