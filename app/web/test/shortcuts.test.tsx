import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import App from '../src/App.js';
import { available, availableGo, GO_WINDOW_MS, goStep, isTyping, SHORTCUTS, target } from '../src/lib/shortcuts.js';

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

describe('g then a letter', () => {
  const go = availableGo(new Set(['projects']));
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, target: null, ...mods });

  it('g a opens the areas and g p the projects', () => {
    const armed = goStep(key('g'), null, 1000, go);
    expect(armed).toEqual({ to: null, armedAt: 1000 });
    expect(goStep(key('a'), armed.armedAt, 1200, go)).toEqual({ to: '/areas', armedAt: null });
    expect(goStep(key('P'), 1000, 1200, go)).toEqual({ to: '/projects', armedAt: null });
  });

  it('needs the g first, in time, and with no modifier held', () => {
    expect(goStep(key('a'), null, 1000, go).to).toBeNull();
    expect(goStep(key('a'), 1000, 1000 + GO_WINDOW_MS + 1, go).to).toBeNull();
    expect(goStep(key('a', { metaKey: true }), 1000, 1100, go).to).toBeNull();
    // Another key in between drops the sequence.
    expect(goStep(key('x'), 1000, 1100, go)).toEqual({ to: null, armedAt: null });
  });

  it('is off while typing in a field and when the tracker module is off', () => {
    const input = document.createElement('input');
    expect(isTyping(input)).toBe(true);
    expect(isTyping(document.createElement('textarea'))).toBe(true);
    expect(isTyping(document.body)).toBe(false);
    expect(goStep(key('g', { target: input }), null, 1000, go).armedAt).toBeNull();
    expect(goStep(key('a', { target: input }), 1000, 1100, go).to).toBeNull();
    expect(goStep(key('a'), 1000, 1100, availableGo(new Set())).to).toBeNull();
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
      : url.startsWith('/api/meta') ? {
        modules: ['tv', 'agents', 'org'], owner: 'o', devLogPath: null, docsPath: null, robot: false,
        version: '1.2.3', commit: 'abcdef1234567890abcdef1234567890abcdef12', commitShort: 'abcdef1', builtAt: '2026-10-23T17:40:00Z',
      }
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

  it('the info panel says which version and commit is running', async () => {
    renderAt('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Keyboard shortcuts' }));
    const list = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(list.textContent).toContain('Second Brain v1.2.3 · abcdef1');
    // The full hash and the build time are in the tooltip, not the panel line.
    expect(screen.getByText(/Second Brain v1\.2\.3/).getAttribute('title')).toBe(
      'commit abcdef1234567890abcdef1234567890abcdef12 · built ' + new Date('2026-10-23T17:40:00Z').toLocaleString(),
    );
  });

  it('g then a opens /areas where the tracker is on, and the list names the sequence', async () => {
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/meta')) return Response.json({ modules: ['projects'], nav: [{ section: 'Work', label: 'Areas', path: '/areas' }], owner: 'o', devLogPath: null, docsPath: null, robot: false });
      if (url.startsWith('/api/areas')) return Response.json({ areas: [] });
      return base(input);
    }));
    renderAt('/');
    const info = await screen.findByRole('button', { name: 'Keyboard shortcuts' });
    await waitFor(() => {
      fireEvent.keyDown(window, { key: 'g' });
      fireEvent.keyDown(window, { key: 'a' });
      expect(path).toBe('/areas');
    });
    fireEvent.click(info);
    const list = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(list.textContent).toContain('g aAreas');
    expect(list.textContent).toContain('g pProjects');
  });

  it('sends the old /argo-tv kiosk URL to /tv', async () => {
    renderAt('/argo-tv?kiosk=1');
    await waitFor(() => expect(path).toBe('/tv?kiosk=1'));
  });
});
