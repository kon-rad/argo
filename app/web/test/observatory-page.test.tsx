import { fileObservationOf } from '../src/routes/observatory/fileEvidence.js';
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
it('loads changed-line hunks only on demand and labels them as zero-context observations', async () => {
  const legacy = demoWindow.events.find(e => e.id === 'write-result')!;
  const event = { ...legacy, change: undefined, fileObservation: { ...fileObservationOf(legacy)!, origin: 'runtime-observation' as const, diff: { format: 'changed-lines' as const, context: 0 as const, redacted: true as const, truncated: false } } };
  const fetch = setup(`/observatory?from=${demoWindow.from}&to=${demoWindow.to}&cursor=${demoWindow.from + 12500}&event=${event.id}`, url => url.includes('/events/')
    ? { event, detail: { diff: { format: 'changed-lines', truncated: false, hunks: [{ oldStart: 3, newStart: 3, deleted: ['old public\n'], added: ['new public\n', '[redacted:sensitive-line]\n'] }] } } }
    : { window: { ...demoWindow, events: demoWindow.events.map(e => e.id === event.id ? event : e) }, export: 'token', total: demoWindow.events.length, next: null, diagnostics: {} });
  await screen.findByRole('button', { name: 'Load observed diff' });
  expect(fetch.mock.calls.some(([u]) => String(u).includes('/observation'))).toBe(false);
  expect(screen.queryByLabelText('Observed diff detail')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Load observed diff' }));
  const detail = await screen.findByLabelText('Observed diff detail');
  expect(detail.textContent).toContain('zero unchanged context');
  expect(detail.textContent).toContain('@@ old line 3, new line 3 @@');
  expect(detail.textContent).toContain('- old public'); expect(detail.textContent).toContain('+ new public');
  expect(detail.textContent).toContain('[redacted:sensitive-line]');
});
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
  const fetch = setup(`/observatory?from=${demoWindow.from}&to=${demoWindow.to}&cursor=${demoWindow.from + 2000}&event=call`, url => url.includes('/events/') ? { event: call, detail: { availability: 'source-pointer' } } : { window: demoWindow, export: 'token', total: demoWindow.events.length, next: null, diagnostics: {} });
  await screen.findByText(/Outcome at cursor: pending/);
  expect(fetch.mock.calls.some(([u]) => String(u).includes('/events/'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Verify source detail' }));
  const link = await screen.findByRole('link', { name: 'Open recorded session part' });
  expect(link.getAttribute('href')).toBe('/usage/session/lab/demo-session?source=codex&part=2%3Acall');
});
it('rejects partial and changed pagination instead of replaying incomplete history', async () => {
  const state = { from: demoWindow.from, to: demoWindow.to, cursor: demoWindow.from };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ window: { ...demoWindow, events: [] }, export: 'a', total: demoWindow.events.length, next: null, diagnostics: {} }))));
  await expect(loadSnapshot(state, new AbortController().signal)).rejects.toThrow(/Incomplete/);
  let count = 0;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ window: { ...demoWindow, events: demoWindow.events.slice(0, 1) }, export: ++count === 1 ? 'a' : 'b', total: demoWindow.events.length, next: 1, diagnostics: {} }))));
  await expect(loadSnapshot(state, new AbortController().signal)).rejects.toThrow(/Snapshot changed/);
});
it('shows permission denial without claiming empty coverage', async () => {
  setup(`/observatory?from=${demoWindow.from}&to=${demoWindow.to}`, () => ({ error: { message: 'source permission denied' } }), 403);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('source permission denied'));
  expect(screen.queryByText('No evidenced active executions at this cursor.')).toBeNull();
});
it('keeps denied detail explicit and offers no verified-source link', async () => {
  setup(`/observatory?from=${demoWindow.from}&to=${demoWindow.to}&cursor=${demoWindow.from + 2000}&event=call`, url => url.includes('/events/') ? { error: { message: 'source no longer visible' } } : { window: demoWindow, export: 'token', total: demoWindow.events.length, next: null, diagnostics: {} });
  await screen.findByText(/Outcome at cursor: pending/);
  // Use the actual HTTP denial after loading the window.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'source no longer visible' } }), { status: 403 })));
  fireEvent.click(screen.getByRole('button', { name: 'Verify source detail' }));
  await screen.findByText(/source no longer visible/);
  expect(screen.queryByRole('link', { name: 'Open recorded session part' })).toBeNull();
});
it('assembles all immutable pages and preserves the export token', async () => {
  let count = 0;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ window: { ...demoWindow, events: count++ === 0 ? demoWindow.events.slice(0, 3) : demoWindow.events.slice(3) }, export: 'same', total: demoWindow.events.length, next: count === 1 ? 3 : null, diagnostics: {} }))));
  const snapshot = await loadSnapshot({ from: demoWindow.from, to: demoWindow.to, cursor: demoWindow.from }, new AbortController().signal);
  expect(snapshot.window.events).toEqual(demoWindow.events);
  expect(snapshot.export).toBe('same');
});

it('loads legacy-reported snapshot text only on explicit request without transition ownership', async () => {
  const result = demoWindow.events.find(e => e.id === 'write-result')!;
  const fetch = setup(`/observatory?from=${demoWindow.from}&to=${demoWindow.to}&cursor=${demoWindow.from + 12500}&event=write-result`, url =>
    url.includes('/observation?') ? { event: result, detail: { representation: 'redacted-source', diff: { format: 'replacement', before: '', after: 'synthetic diff body', truncated: false } } }
      : { window: demoWindow, export: 'token', total: demoWindow.events.length, next: null, diagnostics: {} });
  await screen.findByLabelText('File observation evidence');
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/observation?'))).toBe(false);
  expect(screen.queryByText(/synthetic diff body/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Load observed diff' }));
  await screen.findByText(/synthetic diff body/);
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/observation?export=token'))).toBe(true);
});

it.each(['authorized-summary', 'hidden', 'unavailable'])('displays lazy thinking state %s', async availability => {
  const thinking = demoWindow.events.find(e => e.id === 'thinking')!;
  setup(`/observatory?from=${demoWindow.from}&to=${demoWindow.to}&cursor=${demoWindow.from + 4500}&event=thinking`, url => url.includes('/events/') ? { event: thinking, detail: { thinking: { availability, ...(availability === 'authorized-summary' ? { summary: 'Synthetic permitted summary' } : {}) } } } : { window: demoWindow, export: 'thinking-token', total: demoWindow.events.length, next: null, diagnostics: {} });
  await screen.findByText(/Thinking: not checked/);
  expect(screen.queryByLabelText('Authorized thinking summary')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Verify source detail' }));
  await screen.findByText(`Thinking: ${availability}. No reasoning reconstructed.`);
  if (availability === 'authorized-summary') expect(screen.getByLabelText('Authorized thinking summary').textContent).toBe('Synthetic permitted summary');
  else expect(screen.queryByLabelText('Authorized thinking summary')).toBeNull();
});

import type { EvidenceEvent } from '@secondbrain/contracts/observatory';
it('renders evidenced source origins under human, agent and unknown filters', async () => {
  // Adapter sender extraction is covered by server tests; exercise the browser transport contract here.
  const events: EvidenceEvent[] = (['human', 'agent', 'unknown'] as const).map((kind, id) => ({
    ...demoWindow.events[0]!, id: `origin:${id}`, at: demoWindow.from + id,
    actor: { kind, sender: 'fixture-sender', channel: null, evidence: 'archive-recorded-sender' },
  }));
  const window = { ...demoWindow, events };
  setup(`/observatory?from=${window.from}&to=${window.to}&cursor=${window.from + 100}`, () => ({ window, export: 'origin-token', total: 3, next: null, diagnostics: {} }));
  await screen.findByText('Events through cursor (3; latest 200 shown)');
  for (const [kind, glyph] of [['human', '◆ H'], ['agent', '● A'], ['unknown', '◇ unknown']]) {
    fireEvent.change(screen.getByLabelText('Origin'), { target: { value: kind } });
    await screen.findByText('Events through cursor (1; latest 200 shown)');
    const timeline = screen.getByRole('region', { name: 'Recorded event timeline' });
    expect(timeline.textContent).toContain(glyph);
  }
});

it.each(['tool-reported-success', 'captured-hashes', 'captured-diff', 'commit'] as const)('keeps unknown-outcome %s metadata unverified without captured inspector or diff controls', async level => {
  const call = demoWindow.events.find(e => e.id === 'write-call')!;
  const source = demoWindow.events.find(e => e.id === 'write-result')!;
  const result = { ...source, outcome: 'unknown' as const, change: level === 'tool-reported-success' ? undefined : { ...source.change!, level }, writeEvidence: 'tool-reported-success' as const };
  const window = { ...demoWindow, events: [call, result] };
  const fetch = setup(`/observatory?from=${window.from}&to=${window.to}&cursor=${window.from + 12500}&event=${result.id}`, () => ({ window, export: 'token', total: 2, next: null, diagnostics: {} }));
  await screen.findByText('Outcome at cursor: unknown');
  expect(screen.queryByLabelText('File observation evidence')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Load observed diff' })).toBeNull();
  expect(screen.queryByLabelText('Observed diff detail')).toBeNull();
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/observation'))).toBe(false);
  fireEvent.change(screen.getByLabelText('Replay cursor'), { target: { value: window.from + 12499 } });
  expect(screen.queryByLabelText('File observation evidence')).toBeNull();
});
