import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Fund from '../src/routes/Fund.js';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const wallet = (key: string, label: string, n: number, usd: number | null, error: string | null = null) => ({
  key, label, role: `${label} role`, address: n ? addr(n) : null, usd, partial: false, error,
  balances: error ? [] : [{ symbol: 'ETH', amount: 0.01, usd: 20 }, { symbol: 'USDC', amount: 70, usd: 70 }],
});
const OVERVIEW = {
  configured: true, dir: 'fund', chainId: 8453, explorer: 'https://explorer.example', threshold: 2, ethUsd: 2000, navUsd: 90, navPartial: false,
  wallets: [wallet('safe', 'Fund Safe', 1, 90), wallet('agent', 'Agent', 2, 2), wallet('deck', 'Deck', 0, null, 'address not set')],
  pending: [{
    id: '2026-10-22-1', created: '2026-10-22T00:00:00Z', kind: 'swap', title: 'Sell 30 USDC for WETH', status: 'proposed', tally: '3–0', meeting: '2026-10-22',
    votes: [{ partner: 'Wren', vote: 'yes', reason: 'tide is coming in' }], txHash: null, result: null,
  }],
  proposals: [],
  transactions: [
    { when: '2026-10-21T00:00:00Z', kind: 'swap', title: 'Sell 30 USDC for WETH', hash: `0x${'a'.repeat(64)}`, proposal: 'p1', confirmed: true, gasEth: 0.00002 },
    { when: '2026-10-20T00:00:00Z', kind: 'transfer-in', title: 'Received 100 USDC', hash: `0x${'b'.repeat(64)}`, proposal: null, confirmed: true, gasEth: null },
  ],
  meetings: [{ name: '2026-10-21.md', path: 'fund/meetings/2026-10-21.md', title: 'Meeting', note: 'Hold: no motion tabled.' }],
  research: [], reviews: [], harness: { header: [], rows: [] },
  runs: [{ skill: 'fund-committee', at: '2026-10-21T00:00:00Z', failed: true, reason: 'usage limit', file: 'x' }],
  warnings: ['The agent wallet is low on ETH for gas.'], chainErrors: [], asOf: '2026-10-22T00:00:00Z',
};

function mount(body: unknown = OVERVIEW) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Fund /></MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Fund page', () => {
  it('shows the Safe value, each wallet, warnings and the history', async () => {
    mount();
    expect((await screen.findByTestId('nav')).textContent).toBe('$90.00');
    const safe = screen.getByTestId('wallet-safe');
    expect(within(safe).getByText('USDC')).toBeTruthy();
    expect(within(safe).getByTitle(addr(1)).getAttribute('href')).toBe(`https://explorer.example/address/${addr(1)}`);
    expect(within(screen.getByTestId('wallet-deck')).getByText('address not set')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('low on ETH');
    expect(screen.getAllByText('Sell 30 USDC for WETH').length).toBeGreaterThan(1);
    expect(screen.getByText('Received 100 USDC')).toBeTruthy();
    expect(screen.getAllByText('confirmed')).toHaveLength(2);
    expect(screen.getByText(/fund-committee/)).toBeTruthy();
    expect(screen.getByText(/failed: usage limit/)).toBeTruthy();
  });

  it('opens a pending proposal to show the votes and says the page cannot approve', async () => {
    mount();
    await screen.findByTestId('nav');
    fireEvent.click(screen.getAllByText('Sell 30 USDC for WETH')[0]!);
    await waitFor(() => expect(screen.getByText('tide is coming in')).toBeTruthy());
    expect(screen.getByText(/This page cannot/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('explains an unconfigured install instead of showing zeros', async () => {
    mount({ ...OVERVIEW, configured: false, wallets: [], pending: [], transactions: [], meetings: [], runs: [], warnings: [] });
    expect(await screen.findByText(/No fund is set up here/)).toBeTruthy();
    expect(screen.queryByTestId('nav')).toBeNull();
  });
});
