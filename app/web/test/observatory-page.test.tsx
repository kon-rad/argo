import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Observatory from '../src/routes/observatory/Observatory.js';
import { demoWindow } from '../src/routes/observatory/demo.js';
import { loadSnapshot } from '../src/routes/observatory/api.js';
vi.mock('../src/routes/observatory/Workspace.js', () => ({ default: () => <div>Mock 3D renderer</div> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function Location() { return <output data-testid="url">{useLocation().search}</output>; }
function setup(path: string, handler?: (url: string) => unknown, status = 200) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).endsWith('/meta') ? { timezone: 'UTC' } : handler?.(String(input)) ?? {}), { status }));
  vi.stubGlobal('fetch', fetch);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[path]}><Observatory /><Location /></MemoryRouter></QueryClientProvider>);
  return fetch;
}
it('restores cursor, exposes accessible list and cuts off result until next event', async () => {
  setup(`/observatory?demo=1&from=${demoWindow.from}&to=${demoWindow.to}&cursor=${demoWindow.from + 2000}&event=call`);
  await screen.findByText(/Outcome at cursor: pending/);
  expect(screen.queryByRole('button', { name: /tool_result/ })).toBeNull();
  expect(screen.getByText(/Provenance: synthetic fixture only/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next event' }));
  await screen.findByRole('button', { name: /tool_result/ });
  fireEvent.change(screen.getByLabelText('Replay cursor'), { target: { value: demoWindow.from + 7000 } });
  await screen.findByText('No evidenced active executions at this cursor.');
  expect(screen.getByTestId('url').textContent).toContain(`cursor=${demoWindow.from + 7000}`);
});
it('verifies source lazily then links exact recorded part', async () => {
  const call = demoWindow.events.find(e => e.id === 'call')!;
  const fetch = setup(`/observatory?from=${demoWindow.from}&to=${demoWindow.to}&cursor=${demoWindow.from + 2000}&event=call`, url => url.includes('/events/') ? { event: call, detail: { availability: 'source-pointer' } } : { window: demoWindow, export: 'token', total: 6, next: null, diagnostics: {} });
  await screen.findByText(/Outcome at cursor: pending/);
  expect(fetch.mock.calls.some(([u]) => String(u).includes('/events/'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Verify source detail' }));
  const link = await screen.findByRole('link', { name: 'Open recorded session part' });
  expect(link.getAttribute('href')).toBe('/usage/session/lab/demo-session?source=codex&part=2%3Acall');
});
it('rejects partial and changed pagination instead of replaying incomplete history', async () => {
  const state = { from: demoWindow.from, to: demoWindow.to, cursor: demoWindow.from };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ window: { ...demoWindow, events: [] }, export: 'a', total: 6, next: null, diagnostics: {} }))));
  await expect(loadSnapshot(state, new AbortController().signal)).rejects.toThrow(/Incomplete/);
  let count = 0;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ window: { ...demoWindow, events: demoWindow.events.slice(0, 1) }, export: ++count === 1 ? 'a' : 'b', total: 6, next: 1, diagnostics: {} }))));
  await expect(loadSnapshot(state, new AbortController().signal)).rejects.toThrow(/Snapshot changed/);
});
it('shows permission denial without claiming empty coverage', async () => {
  setup(`/observatory?from=${demoWindow.from}&to=${demoWindow.to}`, () => ({ error: { message: 'source permission denied' } }), 403);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('source permission denied'));
  expect(screen.queryByText('No evidenced active executions at this cursor.')).toBeNull();
});
it('keeps denied detail explicit and offers no verified-source link', async () => {
  setup(`/observatory?from=${demoWindow.from}&to=${demoWindow.to}&cursor=${demoWindow.from + 2000}&event=call`, url => url.includes('/events/') ? { error: { message: 'source no longer visible' } } : { window: demoWindow, export: 'token', total: 6, next: null, diagnostics: {} });
  await screen.findByText(/Outcome at cursor: pending/);
  // Use the actual HTTP denial after loading the window.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'source no longer visible' } }), { status: 403 })));
  fireEvent.click(screen.getByRole('button', { name: 'Verify source detail' }));
  await screen.findByText(/source no longer visible/);
  expect(screen.queryByRole('link', { name: 'Open recorded session part' })).toBeNull();
});
it('assembles all immutable pages and preserves the export token', async () => {
  let count = 0;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ window: { ...demoWindow, events: count++ === 0 ? demoWindow.events.slice(0, 3) : demoWindow.events.slice(3) }, export: 'same', total: 6, next: count === 1 ? 3 : null, diagnostics: {} }))));
  const snapshot = await loadSnapshot({ from: demoWindow.from, to: demoWindow.to, cursor: demoWindow.from }, new AbortController().signal);
  expect(snapshot.window.events).toEqual(demoWindow.events);
  expect(snapshot.export).toBe('same');
});
