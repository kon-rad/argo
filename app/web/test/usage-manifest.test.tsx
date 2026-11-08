import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Usage from '../src/routes/usage/Usage.js';
import type { SubscriptionUsage, UsageConfig } from '../src/lib/api.js';

const weekly = { key: 'weekly', label: 'Weekly', window_minutes: 10080, used_pct: 28, left_pct: 72,
  resets_at: '2099-01-01T00:00:00Z', observed_at: '2026-11-08T00:00:00Z', reset_since_reading: false, last_pct: 28 };
const codex: SubscriptionUsage = { provider: 'codex', label: 'Codex', status: 'ok', observed_at: '2026-11-08T00:00:00Z', source: 'account API', message: 'Weekly limit only', stale: false, windows: [weekly] };
const claude: SubscriptionUsage = { provider: 'claude-code', label: 'Claude Code', status: 'ok', observed_at: '2026-11-08T00:00:00Z', source: 'status line', message: null, stale: false, windows: [weekly] };

function setup(config: UsageConfig, providers: SubscriptionUsage[] = [codex, claude], configStatus = 200) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/usage/config') ? config : url.includes('/usage/subscriptions') ? { providers }
      : url.includes('/usage/credits') ? { providers: [], history: [] }
        : url.includes('/usage/live') ? { total: 0, agents: [], machines: [] }
          : url.includes('/meta') ? { modules: ['usage', 'summaries'] }
            : url.includes('/usage/plan') ? { current: { five_hour: null, seven_day: null }, history: [] }
              : url.includes('/usage/series') ? { bucket: 'hour', tz: 'UTC', rows: [] }
                : url.includes('/usage/facets') ? { total: { calls: 0, tokens: 0 }, facets: {} }
                  : url.includes('/usage/runs') ? { runs: [] }
                    : url.includes('/usage/org-wakes') ? { agents: [] }
                      : url.includes('/usage/agent-sessions/facets') ? { facets: {} }
                        : url.includes('/usage/agent-sessions') ? { sessions: [], total: 0 }
                          : {};
    return new Response(JSON.stringify(body), { status: url.includes('/usage/config') ? configStatus : 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><Usage /></MemoryRouter></QueryClientProvider>);
  return () => fetcher.mock.calls.map(([input]) => String(input));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Usage manifest', () => {
  it('renders Codex weekly-only limits without inventing a five-hour limit or Claude calls', async () => {
    const calls = setup({ subscriptions: ['codex'], credits: [], sections: ['ledger'] }, [codex]);
    expect(await screen.findByText('72% remaining')).toBeTruthy();
    expect(screen.getByText('Weekly limit only')).toBeTruthy();
    expect(screen.queryByText(/5-hour/i)).toBeNull();
    expect(screen.queryByText('Claude Code')).toBeNull();
    expect(calls().some((url) => url.includes('/usage/plan'))).toBe(false);
    expect(calls().some((url) => url.includes('/usage/credits'))).toBe(false);
  });

  it('renders Claude alone and loads its ledger history only on the ledger tab', async () => {
    const calls = setup({ subscriptions: ['claude-code'], credits: [], sections: ['sessions', 'ledger'] }, [claude]);
    expect(await screen.findByRole('article', { name: 'Claude Code subscription usage' })).toBeTruthy();
    expect(calls().some((url) => url.includes('/usage/plan'))).toBe(false);
    fireEvent.click(screen.getByRole('tab', { name: 'Ledger' }));
    await waitFor(() => expect(calls().some((url) => url.includes('/usage/plan'))).toBe(true));
    expect(screen.queryByText('Codex')).toBeNull();
  });

  it('uses manifest order for both subscriptions and credits', async () => {
    setup({ subscriptions: ['claude-code', 'codex'], credits: ['gemini', 'openrouter'], sections: [] }, [codex, claude]);
    await screen.findByRole('article', { name: 'Codex subscription usage' });
    expect(screen.getAllByRole('article').map((article) => article.getAttribute('aria-label'))).toEqual(['Claude Code subscription usage', 'Codex subscription usage']);
    expect(screen.getByText('Gemini API: no reading returned.').compareDocumentPosition(screen.getByText('OpenRouter: no reading returned.')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows a configure hint and makes no provider request when empty', async () => {
    const calls = setup({ subscriptions: [], credits: [], sections: [] }, []);
    expect(await screen.findByText(/No account providers configured/)).toBeTruthy();
    expect(calls().some((url) => url.includes('/usage/subscriptions') || url.includes('/usage/credits'))).toBe(false);
  });

  it('marks unavailable, stale, reset and expired readings explicitly', async () => {
    const reset = { ...weekly, key: 'reset', label: 'Reset window', used_pct: null, left_pct: null, reset_since_reading: true, last_pct: 82 };
    const expired = { ...weekly, key: 'expired', label: 'Expired window', resets_at: '2020-01-01T00:00:00Z' };
    setup({ subscriptions: ['codex'], credits: [], sections: [] }, [{ ...codex, status: 'unavailable', stale: true, message: 'Account source timed out', windows: [weekly, reset, expired] }]);
    expect(await screen.findByText('Stale reading')).toBeTruthy();
    expect(screen.getByText('Unavailable')).toBeTruthy();
    expect(screen.getByText('Reset since last reading')).toBeTruthy();
    expect(screen.getByText('Last reading: 82% used')).toBeTruthy();
    expect(screen.getByText('Reading expired')).toBeTruthy();
    expect(screen.getByText('Account source timed out')).toBeTruthy();
  });

  it('does not poll disabled sections', async () => {
    const calls = setup({ subscriptions: [], credits: [], sections: ['sessions'] }, []);
    await screen.findByRole('tab', { name: 'Sessions' });
    await waitFor(() => expect(calls().some((url) => url.includes('/usage/agent-sessions'))).toBe(true));
    expect(calls().some((url) => ['/usage/live', '/usage/running', '/usage/series', '/usage/plan', '/usage/facets', '/usage/runs', '/usage/org-wakes', '/usage/summaries'].some((path) => url.includes(path)))).toBe(false);
    expect(screen.queryByRole('tab', { name: 'Server processes' })).toBeNull();
  });

  it('shows configuration errors without assuming providers or sections', async () => {
    const calls = setup({ subscriptions: [], credits: [], sections: [] }, [], 500);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Usage configuration did not load. Account limits and sections are unavailable.');
    expect(calls().some((url) => url.includes('/usage/subscriptions') || url.includes('/usage/credits') || url.includes('/usage/series'))).toBe(false);
  });
});
