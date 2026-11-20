import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import MapPage from '../src/routes/Map.js';
import Observatory from '../src/routes/observatory/Observatory.js';
import { mapGraph as graph, mapWindow as window } from './fixtures/observatoryMap.js';
vi.mock('../src/routes/observatory/Workspace.js', () => ({ default: () => <div>Workspace canvas mock</div> }));
const mapProps = vi.hoisted(() => ({ activity: [] as any[] }));
vi.mock('../src/components/map/FullMap.js', () => ({ FullMap: (props: any) => { mapProps.activity = props.activity; return <button onClick={() => props.onSelect('note:1')}>Pick map note</button>; } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function Location() { const l = useLocation(); return <output data-testid="url">{l.pathname}{l.search}</output>; }
function setup(enabled = true, layoutMissing = false) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const data = url.includes('/meta') ? { modules: enabled ? ['map', 'observatory'] : ['map'], timezone: 'UTC' }
      : url.includes('/map/graph') ? layoutMissing ? { error: 'requested layout unavailable' } : graph
      : url.includes('/map/metrics') ? { metrics: [] }
      : url.includes('/observatory/window') ? { window, total: window.events.length, next: null, export: 'fixture', diagnostics: {} } : {};
    return new Response(JSON.stringify(data), { status: layoutMissing && url.includes('/map/graph') ? 404 : 200 });
  });
  vi.stubGlobal('fetch', fetch);
  const path = `/map?activity=1&from=${window.from}&to=${window.to}&cursor=${window.from + 2000}&event=read`;
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[path]}><Routes><Route path="/map" element={<MapPage />} /><Route path="/observatory" element={<Observatory />} /></Routes><Location /></MemoryRouter></QueryClientProvider>);
  return fetch;
}
it('pins layout, filters by note, highlights selected execution and carries state between views', async () => {
  const fetch = setup();
  await screen.findByText(/Current topology is context only/);
  await screen.findByText(/Unresolved: missing, moved, deleted/);
  expect(screen.getByText(/Repository\/path target/)).toBeTruthy();
  expect(screen.getByRole('button', { name: /○ R read attempt: \/srv\/vault/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: /▲ W write attempt/ })).toBeTruthy();
  await waitFor(() => expect(screen.getByTestId('url').textContent).toContain('layout=7'));
  expect(fetch.mock.calls.filter(([url]) => String(url).includes('/map/graph'))).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /● A.*run:lab:parallel/ }));
  await waitFor(() => expect(mapProps.activity.map(a => a.event.id)).toEqual(['write']));
  fireEvent.click(screen.getByRole('button', { name: 'Pick map note' }));
  await waitFor(() => expect(screen.getByTestId('url').textContent).toContain('note=Projects%2Fdemo.md'));
  expect(screen.queryByRole('button', { name: /tool_call.*src\/demo/ })).toBeNull();
  fireEvent.click(screen.getByRole('link', { name: 'Workspace replay' }));
  await screen.findByText('Workspace canvas mock');
  expect(screen.getByTestId('url').textContent).toContain(`cursor=${window.from + 2000}`);
  expect(screen.getByTestId('url').textContent).toContain('event=run%3Alab%3Aparallel');
  expect(screen.getByTestId('url').textContent).toContain('layout=7');
  fireEvent.click(screen.getByRole('link', { name: 'Brain Map replay' }));
  await screen.findByText(/Current topology is context only/);
  expect(screen.getByTestId('url').textContent).toContain('note=Projects%2Fdemo.md');
});
it('keeps the existing map when observatory is disabled, even for an activity URL', async () => {
  const fetch = setup(false);
  await screen.findByText('1 notes · 0 areas · 0 projects · layout v7');
  expect(screen.queryByRole('link', { name: 'Show activity' })).toBeNull();
  expect(screen.queryByRole('slider')).toBeNull();
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/observatory/'))).toBe(false);
});
it('makes unavailable pinned layouts explicit instead of drawing a different graph', async () => {
  setup(true, true);
  await screen.findByText(/Pinned layouts are never silently replaced/);
  expect(screen.queryByText(/Current topology is context only/)).toBeNull();
});
