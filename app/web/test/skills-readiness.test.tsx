import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Machines from '../src/routes/skills/Machines.js';
import { skillsApi } from '../src/routes/skills/api.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('distinguishes installed package matches from prerequisite readiness', async () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  vi.spyOn(skillsApi, 'machines').mockResolvedValue({ hosts: [{ host: 'm4', display: 'M4', status: 'not-ready', lastAck: '2026-01-01T00:00:00Z', views: [{
    agent: 'alpha', runtime: 'zen-agent', status: 'not-ready', error: null, viewDigest: digest, generatedAt: '2026-01-01T00:00:00Z', receivedAt: '2026-01-01T00:00:00Z', dirty: [],
    missing: [{ skill: 'clip', bins: ['ffmpeg'], env: ['VIDEO_KEY'] }], skills: [{ name: 'clip', desired: digest, observed: digest, state: 'match' }],
  }] }], mode: 'managed', staleAfterHours: 24, notes: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Machines /></QueryClientProvider>);
  expect(await screen.findByText('missing prerequisites')).toBeTruthy();
  expect(screen.getByText('not-ready')).toBeTruthy();
  expect(screen.getByText('clip is missing program ffmpeg, setting VIDEO_KEY')).toBeTruthy();
  expect(screen.queryByText('up to date')).toBeNull();
});
