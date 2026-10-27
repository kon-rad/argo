import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import LiveAgents from '../src/routes/usage/LiveAgents.js';

const agent = (o: Record<string, unknown>) => ({ id: 'proc:1', machine: 'srv', harness: 'claude-code', name: 'atlas', model: 'opus', task: { cardId: 't_abc123', label: 'Write the doc', reason: 'task' },
  source: 'process', turns: 7, tokens: { input: 4000, output: 1000 }, startedAt: '2026-10-27T11:58:00Z', lastActivityAt: null, elapsedSec: 120, log: null, pid: 1, runId: 'r', stoppable: true, ...o });
const LIVE = { at: '2026-10-27T12:00:00Z', serverMachine: 'srv', total: 2, machines: [
  { slug: 'srv', display: 'Server', kind: 'server', agents: [agent({})] },
  { slug: 'laptop', display: 'Laptop', kind: 'laptop', agents: [agent({ id: 'session:laptop:s1', machine: 'laptop', name: 'claude-code', source: 'session', stoppable: false, pid: null,
    log: { host: 'laptop', externalId: 's1', source: 'claude-code' }, lastActivityAt: new Date().toISOString() })] },
] };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Live agents page', () => {
  it('shows a group per machine, links the card and the logs, and only offers stop where it can work', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(input).includes('/usage/live/stop') ? { ok: true, pid: 1, signal: 'SIGTERM' } : LIVE;
      void init;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><LiveAgents /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByRole('region', { name: 'Server' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Laptop' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 't_abc123' })[0]!.getAttribute('href')).toBe('/board/t_abc123');
    expect(screen.getByRole('link', { name: 'Logs' }).getAttribute('href')).toContain('/usage/session/laptop/s1');
    expect(screen.getAllByText('stop on its machine')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Stop…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u).includes('/usage/live/stop') && String(i?.body).includes('"force":true'))).toBe(true));
  });
});
