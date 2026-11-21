import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Org from '../src/routes/org/Org.js';
import { runtimePreview, runtimeStatus } from './fixtures/runtime.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(mode = '') {
  const { changes, uncovered } = runtimePreview(true);
  const version = { version: 1, changes, uncovered, status: 'partially-applied', profile_id: 'standard', profile_version: 2,
    applied_by: 'owner', created_at: '2026-01-02T00:00:00Z', reverted_version: null };
  const post = vi.fn();
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (path === '/api/meta') return Response.json({ modules: ['org', 'usage'] });
    if (path === '/api/usage/config') return Response.json({ sections: ['sessions','running'] });
    if (path === '/api/org/runtime') return Response.json(mode === 'history' ? { ...runtimeStatus, desiredVersion: 1, history: [version],
      receipts: [{ version: 1, kind: 'org-agent', target_id: 'guide', status: 'verification-failed', assignment: changes[0]!.to, observed_at: null }] } : runtimeStatus);
    const body = JSON.parse(String(init?.body));
    post(path, body);
    if (path.endsWith('/preview')) return Response.json(runtimePreview(body.scope.length > 0, mode === 'expired'));
    if (mode === 'stale') return Response.json({ error: { message: 'stale preview; preview again' } }, { status: 400 });
    return Response.json({ version: 2, changes, uncovered, status: 'org-applied' });
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/org/runtime?agent=guide']}><Routes><Route path="/org/*" element={<Org />} /></Routes></MemoryRouter>
  </QueryClientProvider>);
  return post;
}
async function preview(scoped = false) {
  const scope = await screen.findByLabelText('Scope');
  if (scoped) fireEvent.change(scope, { target: { value: 'org' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
  return screen.findByRole<HTMLButtonElement>('button', { name: scoped ? 'Apply to future wakes' : 'Apply whole fleet' });
}
it('reviews every target, names blockers and stacks labelled cells on phones', async () => {
  const post = setup();
  expect((await preview()).disabled).toBe(true);
  expect(post.mock.calls).toEqual([['/api/org/runtime/preview', { profileId: 'standard', scope: [] }]]);
  const ledger = screen.getByRole('table', { name: 'Coverage ledger' });
  expect(ledger.getAttribute('data-phone')).toBe('cards');
  const row = within(ledger).getByText('guide', { exact: true }).closest('tr')!;
  expect(row.getAttribute('aria-current')).toBe('true');
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Review change' }));
  expect(screen.getByRole('link', { name: 'Runtime settings' }).getAttribute('aria-current')).toBe('page');
  expect(within(ledger).getAllByText('Unverified')).toHaveLength(4);
  for (const [label, value] of [['Configured','base-model'],['Effective now','effective-model'],['Last observed','observed-model'],['Proposed','next-model']]) {
    expect(row.querySelector('[data-label="' + label + '"]')?.textContent).toContain(value);
  }
  expect(within(ledger).getByText('Default poller inactive')).toBeTruthy();
  expect(within(ledger).getAllByText('unsupported: no registered launcher adapter')).toHaveLength(3);
  expect(screen.getByText('5 in scope · 4 blocked · 0 outside scope')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Running now' }).getAttribute('href')).toBe('/usage?view=running');
});
it.each(['expired','stale'])('requires a fresh review after a %s preview', async mode => {
  setup(mode);
  const apply = await preview(true);
  if (mode === 'stale') fireEvent.click(apply);
  expect((await screen.findByRole('alert')).textContent).toMatch(new RegExp(mode, 'i'));
  expect(screen.queryByRole<HTMLButtonElement>('button', { name: 'Apply to future wakes' })?.disabled ?? true).toBe(true);
});
it('submits only reviewed org targets and announces scoped coverage', async () => {
  const post = setup();
  fireEvent.click(await preview(true));
  await screen.findByText(/Version 2.*1 in scope.*4 outside scope/);
  expect(post.mock.calls).toEqual([
    ['/api/org/runtime/preview', { profileId: 'standard', scope: [{ kind: 'org-agent', id: 'guide' }] }],
    ['/api/org/runtime/apply', { token: 'reviewed-token' }],
  ]);
});
it('shows partial reconciliation and the receipt, then confirms the exact version to revert', async () => {
  const post = setup('history');
  expect(await screen.findAllByText(/partially applied/i)).not.toHaveLength(0);
  expect(screen.getAllByText(/verification-failed/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Revert version 1' }));
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm revert of version 1' }));
  await screen.findByText(/Version 2.*1 in scope.*4 outside scope/);
  expect(post).toHaveBeenCalledWith('/api/org/runtime/revert', { version: 1 });
});

it('discards whole-fleet review when the scope changes and keeps the excluded targets visible', async () => {
  const post = setup();
  await preview();
  fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'org' } });
  expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Preview change' }));
  await screen.findByRole('button', { name: 'Apply to future wakes' });
  expect(screen.getByText('1 in scope · 0 blocked · 4 outside scope')).toBeTruthy();
  expect(within(screen.getByRole('table')).getAllByText('Outside scope')).toHaveLength(4);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Preview change' }));
  expect(post).toHaveBeenCalledTimes(2);
});
