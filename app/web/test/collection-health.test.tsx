import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import CollectionHealth from '../src/routes/usage/CollectionHealth.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('keeps stale remote path visible beside a fresh local path', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ streams: [
    { host: 'laptop-a', collector_instance: 'push', runtime: 'codex', path: '/synthetic/a', state: 'healthy', backlog: 0, backlog_unit: 'bytes', quarantined: 2 },
    { host: 'laptop-b', collector_instance: 'ledger', runtime: 'claude-code', path: '/synthetic/b', state: 'offline', backlog: null, reason: 'network' },
  ] }), { headers: { 'Content-Type': 'application/json' } })));
  render(<QueryClientProvider client={new QueryClient()}><CollectionHealth /></QueryClientProvider>);
  expect(await screen.findByText(/laptop-b/)).toBeTruthy();
  expect(screen.getByText(/offline/)).toBeTruthy();
  expect(screen.getByText(/backlog unknown/)).toBeTruthy();
  expect(screen.getByText(/healthy/)).toBeTruthy();
  expect(screen.getByText(/backlog 0 bytes/)).toBeTruthy();
  expect(screen.getByText(/quarantined 2/)).toBeTruthy();
});
