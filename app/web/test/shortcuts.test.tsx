import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import App from '../src/App.js';
import { available, SHORTCUTS, target } from '../src/lib/shortcuts.js';

const press = (code: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ code, key: code.replace(/^Key/, '').toLowerCase(), ctrlKey: true, metaKey: true, altKey: false, shiftKey: false, ...mods });

describe('shortcut keys', () => {
  const all = available(new Set(['tv', 'agents', 'org', 'map', 'projects', 'usage', 'ring']));

  it('maps Ctrl+Meta+letter to its page', () => {
    expect(target(press('KeyT'), all)).toBe('/tv');
    expect(target(press('KeyA'), all)).toBe('/agents');
    expect(target(press('KeyO'), all)).toBe('/org');
  });

  it('opens the full-screen view with Shift, where a page has one', () => {
    expect(target(press('KeyT', { shiftKey: true }), all)).toBe('/tv?kiosk=1');
    expect(target(press('KeyA', { shiftKey: true }), all)).toBe('/agents');
  });

  it('falls back to the typed letter when the code is wrong (wtype on the Pi)', () => {
    expect(target(press('Escape', { key: 'a' }), all)).toBe('/agents');
    expect(target(press('Escape', { key: 'T', shiftKey: true }), all)).toBe('/tv?kiosk=1');
  });

  it('needs both Ctrl and Meta, and leaves Ctrl+Alt to the Pi', () => {
    expect(target(press('KeyT', { metaKey: false }), all)).toBeNull();
    expect(target(press('KeyT', { ctrlKey: false }), all)).toBeNull();
    expect(target(press('KeyT', { altKey: true }), all)).toBeNull();
  });

  it('drops pages whose module is off', () => {
    expect(target(press('KeyT'), available(new Set()))).toBeNull();
    expect(target(press('KeyB'), available(new Set()))).toBe('/');
  });

  it('gives each key one page and never uses keys macOS or Chrome own', () => {
    const codes = SHORTCUTS.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const taken of ['KeyQ', 'KeyF', 'KeyD', 'Space', 'KeyK']) expect(codes).not.toContain(taken);
  });
});

let path = '';
function Probe() {
  const l = useLocation();
  path = l.pathname + l.search;
  return null;
}

function renderAt(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <App />
        <Probe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.startsWith('/api/auth/me') ? { required: false, authenticated: true }
      : url.startsWith('/api/meta') ? { modules: ['tv', 'agents', 'org'], owner: 'o', devLogPath: null, docsPath: null, robot: false }
      : url.startsWith('/api/tree') ? { path: '', dirs: [], files: [], total: 0, has_more: false }
      : url.startsWith('/api/runs') ? { runs: [] }
      : url.startsWith('/api/sources') ? { sources: [] }
      : url.startsWith('/api/system') ? { vault_root: '/v', counts: { files: 0, markdown: 0, links: 0, tags: 0 } }
      : url.startsWith('/api/tv') ? { episodes: [], shows: {}, episodesDir: '' }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('shortcuts in the app', () => {
  it('Ctrl+Meta+O opens the org page and the info button lists the keys', async () => {
    renderAt('/');
    const info = await screen.findByRole('button', { name: 'Keyboard shortcuts' });
    await waitFor(() => {
      fireEvent.keyDown(window, press('KeyO'));
      expect(path).toBe('/org');
    });
    fireEvent.click(info);
    const list = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(list.textContent).toContain('Agents');
    expect(list.textContent).toContain('TV, full screen');
    expect(list.textContent).not.toContain('Brain map');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sends the old /argo-tv kiosk URL to /tv', async () => {
    renderAt('/argo-tv?kiosk=1');
    await waitFor(() => expect(path).toBe('/tv?kiosk=1'));
  });
});
