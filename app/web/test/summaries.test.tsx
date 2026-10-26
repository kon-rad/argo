import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Summaries from '../src/routes/usage/Summaries.js';

const calls: { url: string; init?: RequestInit }[] = [];
let facts: unknown[] = [];

const summary = (over: Record<string, unknown> = {}) => ({
  id: 1, session_id: 10, harness: 'claude-code', host: 'droplet', profile: null, project: 'shop',
  started_at: '2026-10-26T10:00:00Z', ended_at: '2026-10-26T10:20:00Z',
  request: 'Fix the billing bug', done: 'Deduplicated discount codes.', learned: 'Repeated codes stacked.', open_items: 'Add docs',
  outcome: 'finished', touched: { files_edited: ['/work/invoice.ts'], files_read: 3, cards: ['t_ab12cd34'], tools: { Edit: 1 }, skills: [] },
  metrics: { steps: 9, prompts: 2, tool_calls: 4, error_steps: 1, duration_s: 1200, calls: 5, input_tokens: 10, cache_write_tokens: 100, cache_read_tokens: 1000, output_tokens: 50, models: ['claude-opus-5-5'] },
  writer_provider: 'ollama', writer_model: 'qwen3.6:35b-a3b', title: 'Billing fix', external_id: 'abc', source: 'claude-code', proposed_facts: 1, ...over,
});

function stub(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('/api/summaries/overview')) return json({
      from: 'a', to: 'b', tz: 'UTC', summarized: 2, skipped: 1, proposed_facts: facts.length,
      outcomes: [{ key: 'finished', n: 1 }, { key: 'blocked', n: 1 }],
      days: [{ day: '2026-10-26', sessions: 2, finished: 1, stuck: 1, tokens: 2320, errors_per_session: 1 }],
      writers: [{ key: 'ollama/qwen3.6:35b-a3b', n: 2, input: 1000, output: 200 }],
    });
    if (url.startsWith('/api/summaries/facts/') && url.endsWith('/promote') && init?.method === 'POST') { facts = []; return json({ id: 5, fact_id: 77 }); }
    if (url.startsWith('/api/summaries/facts/') && url.endsWith('/reject') && init?.method === 'POST') { facts = []; return json({ id: 5 }); }
    if (url.startsWith('/api/summaries/facts')) return json({ facts });
    if (url.startsWith('/api/summaries')) return json({ summaries: [summary(), summary({ id: 2, outcome: 'blocked', request: 'Deploy the site', done: 'Stopped at the missing key', external_id: 'def', harness: 'hermes', profile: 'builder' })] });
    return json({ error: { message: `unexpected ${url}` } }, 404);
  }));
}

function renderView(path = '/usage?view=summaries') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Summaries /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  calls.length = 0;
  facts = [{ id: 5, summary_id: 1, subject: 'billing', claim: 'Discount codes are deduplicated.', status: 'proposed', fact_id: null, project: 'shop', harness: 'claude-code', host: 'droplet', session_id: 10, external_id: 'abc', source: 'claude-code', request: 'Fix the billing bug' }];
  stub();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Summaries view', () => {
  it('shows the overview, each summary with computed numbers and its writer, and a link to the transcript', async () => {
    renderView();
    expect(await screen.findByText('Deduplicated discount codes.')).toBeTruthy();
    expect(screen.getByText('Stopped at the missing key')).toBeTruthy();
    expect(screen.getByText(/50%/)).toBeTruthy(); // 1 of 2 finished
    expect(screen.getByText(/1 too short/)).toBeTruthy();
    expect(screen.getAllByText(/written by ollama\/qwen3.6:35b-a3b/).length).toBe(2);
    const open = screen.getAllByText('Open transcript')[0] as HTMLAnchorElement;
    expect(open.getAttribute('href')).toBe('/usage/session/droplet/abc?source=claude-code');
    expect(screen.getAllByText('1 files edited').length).toBe(2);
    expect(screen.getAllByText('t_ab12cd34').length).toBe(2);
    expect(screen.getByText('hermes', { selector: 'button' })).toBeTruthy(); // harness filter offered because two harnesses are present
  });

  it('filters by outcome through the API', async () => {
    renderView();
    await screen.findByText('Deduplicated discount codes.');
    fireEvent.click(screen.getByRole('button', { name: 'blocked' }));
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/summaries?') && c.url.includes('outcome=blocked'))).toBe(true));
  });

  it('promotes a proposed fact and the list empties', async () => {
    renderView();
    expect(await screen.findByText('Discount codes are deduplicated.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/summaries/facts/5/promote' && c.init?.method === 'POST')).toBe(true));
    await waitFor(() => expect(screen.getByText('Nothing waiting.')).toBeTruthy());
  });

  it('rejects a proposed fact', async () => {
    renderView();
    await screen.findByText('Discount codes are deduplicated.');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/summaries/facts/5/reject')).toBe(true));
  });

  it('says what an empty range means', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('/api/summaries/overview')) return json({ from: 'a', to: 'b', tz: 'UTC', summarized: 0, skipped: 0, proposed_facts: 0, outcomes: [], days: [], writers: [] });
      if (url.startsWith('/api/summaries/facts')) return json({ facts: [] });
      return json({ summaries: [] });
    }));
    renderView();
    expect(await screen.findByText(/No summaries in this range/)).toBeTruthy();
    expect(screen.getByText('Nothing waiting.')).toBeTruthy();
  });
});
