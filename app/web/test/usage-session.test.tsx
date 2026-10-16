import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import UsageSession from '../src/routes/usage/UsageSession.js';

const DETAIL = {
  session: { source: 'claude-code', host: 'mac', external_id: 's1', title: 'Plan the usage board', calls: 1, input: 10, cache_write: 100, cache_read: 1000, output: 50 },
  run: null,
  messages: [
    { id: 1, seq: 1, role: 'user', kind: 'user', ts: '2026-10-13T23:29:00Z', text: 'Build the usage board', truncated: false, length: 21, is_sidechain: false, call: null },
    { id: 2, seq: 2, role: 'assistant', kind: 'assistant', ts: '2026-10-13T23:30:00Z', text: 'x'.repeat(20000), truncated: true, length: 30000, is_sidechain: false,
      call: { model: 'claude-opus-5-5', input: 10, cache_write: 100, cache_read: 1000, output: 50 } },
  ],
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('UsageSession', () => {
  it('shows the prompt, the response with its tokens, and loads the full record on demand', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
      String(input).includes('/usage/messages/2') ? { id: 2, raw: { message: { content: 'FULL RECORD' } } } : DETAIL),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/usage/session/mac/s1?source=claude-code']}>
        <Routes><Route path="/usage/session/:host/:externalId" element={<UsageSession />} /></Routes>
      </MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Plan the usage board')).toBeTruthy());
    expect(screen.getByText('Build the usage board')).toBeTruthy();
    expect(screen.getByText(/claude-opus-5-5 · in 10 · cache w 100/)).toBeTruthy();   // the per-call badge
    fireEvent.click(screen.getByRole('button', { name: /show full/i }));
    await waitFor(() => expect(screen.getByText(/FULL RECORD/)).toBeTruthy());
    expect(String(fetchMock.mock.calls[0]![0])).toContain('source=claude-code');
  });

  function renderWith(detail: unknown, path: string) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(detail), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    return render(<QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/usage/session/:host/:externalId" element={<UsageSession />} /></Routes>
      </MemoryRouter></QueryClientProvider>);
  }

  it('never renders a dollar amount for a claude-code session', async () => {
    const run = { host: 'mac', session_id: 's1', task_id: 't9', lane: 'cc-a', board: null, model: null, started_at: null, ended_at: null,
      duration_ms: 1000, num_turns: 3, subtype: 'success', is_error: false, verify_name: 'tests', verify_passed: true, verify_exit: 0, verify_metric: null, verify_output: 'ok' };
    const { container } = renderWith({ ...DETAIL, session: { ...DETAIL.session, cost_usd: 12.34 }, run }, '/usage/session/mac/s1?source=claude-code');
    await waitFor(() => expect(screen.getByText('Plan the usage board')).toBeTruthy());
    expect(container.textContent).not.toContain('$');
    expect(container.textContent).not.toContain('USD');
    expect(container.textContent).toContain('Verify tests: passed');
  });

  it('shows cost in USD for a hermes session', async () => {
    const { container } = renderWith({ ...DETAIL, session: { ...DETAIL.session, source: 'hermes', cost_usd: 1.5 } }, '/usage/session/mac/s1?source=hermes');
    await waitFor(() => expect(screen.getByText('Plan the usage board')).toBeTruthy());
    expect(container.textContent).toContain('1.50 USD');
  });
});
