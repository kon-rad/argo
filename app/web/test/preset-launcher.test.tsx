import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import PresetLauncher, { roleOpening } from '../src/routes/agents/PresetLauncher.js';

const calls: { url: string; init?: RequestInit }[] = [];
let presets: unknown[] = [];

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/presets' && !init?.method) return json({ presets });
      if (url === '/api/presets/default' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        presets = [{ name: 'default', ...body, updated_at: '2026-10-26T00:00:00Z' }];
        return json({ preset: presets[0] });
      }
      if (url.startsWith('/api/presets/') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        const name = url.split('/').pop();
        presets = [...presets.filter((p) => (p as { name: string }).name !== name), { name, ...body, updated_at: 'x' }];
        return json({ preset: presets.at(-1) });
      }
      if (url.startsWith('/api/presets/') && init?.method === 'DELETE') {
        presets = presets.filter((p) => (p as { name: string }).name !== url.split('/').pop());
        return json({ ok: true });
      }
      if (url === '/api/zen/personas') return json({ personas: [{ name: 'ops-lead', role: 'Operations', team: 'ops', runtime: 'claude-code' }] });
      if (url === '/api/zen/models') return json({ providers: [], models: [{ provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', context_window: 1, reasoning: true, configured: true, reachable: null }] });
      if (url === '/api/hub/chats' && init?.method === 'POST') return json({ id: 'aaaaaaaaaaaa' });
      if (url === '/api/hub/chats/aaaaaaaaaaaa/messages') return json({ id: 'aaaaaaaaaaaa' });
      if (url === '/api/zen/chats' && init?.method === 'POST') return json({ id: 'bbbbbbbbbbbb' });
      return json({ error: { message: `unexpected ${url}` } }, 404);
    }),
  );
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/agents/chat']}>
        <PresetLauncher />
        <Routes><Route path="*" element={<Where />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const bodyOf = (url: string, method = 'POST') => {
  const c = calls.find((x) => x.url === url && x.init?.method === method);
  return c ? JSON.parse(String(c.init?.body)) : undefined;
};

beforeEach(() => { calls.length = 0; presets = []; stubFetch(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PresetLauncher', () => {
  it('with nothing saved, the first click opens the settings and creates nothing', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /start a chat from the preset/i }));
    expect(await screen.findByLabelText('Harness')).toBeTruthy();
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
  });

  it('launches a saved Claude Code preset in one click, sending the role as the opening message', async () => {
    presets = [{ name: 'default', harness: 'claude-code', config: { model: 'sonnet', role: 'ops-lead' }, updated_at: 'x' }];
    mount();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/presets')).toBe(true));
    await screen.findByRole('button', { name: /start a chat from the preset/i });
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.click(screen.getByRole('button', { name: /start a chat from the preset/i }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/agents/chat/aaaaaaaaaaaa'));
    expect(bodyOf('/api/hub/chats')).toEqual({ model: 'sonnet' });
    expect(bodyOf('/api/hub/chats/aaaaaaaaaaaa/messages')).toEqual({ text: roleOpening('ops-lead') });
  });

  it('launches a saved zen-agent preset with persona, model, tools and thinking', async () => {
    presets = [{ name: 'default', harness: 'zen-agent', config: { persona: 'ops-lead', model: 'anthropic/claude-sonnet-4-6', tools: 'read-only', thinking: 'low' }, updated_at: 'x' }];
    mount();
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.click(screen.getByRole('button', { name: /start a chat from the preset/i }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/agents/zen/bbbbbbbbbbbb'));
    expect(bodyOf('/api/zen/chats')).toEqual({ persona: 'ops-lead', model: 'anthropic/claude-sonnet-4-6', tools: 'read-only', thinking: 'low' });
  });

  it('saves the settings with the gear, dropping empty fields', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Preset settings' }));
    fireEvent.change(await screen.findByLabelText('Harness'), { target: { value: 'zen-agent' } });
    fireEvent.change(await screen.findByLabelText('Tools'), { target: { value: 'read-only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodyOf('/api/presets/default', 'PUT')).toEqual({ harness: 'zen-agent', config: { tools: 'read-only' } }));
  });

  it('with several presets, the list picks which one the button launches', async () => {
    presets = [
      { name: 'coo', harness: 'zen-agent', config: { persona: 'ops-lead' }, updated_at: 'x' },
      { name: 'quick', harness: 'claude-code', config: { model: 'haiku' }, updated_at: 'x' },
    ];
    mount();
    const pick = (await screen.findByLabelText('Preset')) as HTMLSelectElement;
    expect(pick.value).toBe('coo');
    fireEvent.change(pick, { target: { value: 'quick' } });
    fireEvent.click(screen.getByRole('button', { name: /start a chat from the preset/i }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/agents/chat/aaaaaaaaaaaa'));
    expect(bodyOf('/api/hub/chats')).toEqual({ model: 'haiku' });
    expect(calls.some((c) => c.url === '/api/zen/chats' && c.init?.method === 'POST')).toBe(false);
  });

  it('saving under a new name makes a second preset and leaves the first alone', async () => {
    presets = [{ name: 'coo', harness: 'zen-agent', config: { persona: 'ops-lead' }, updated_at: 'x' }];
    mount();
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.click(screen.getByRole('button', { name: 'Preset settings' }));
    fireEvent.change(await screen.findByLabelText('Preset name'), { target: { value: 'reviewer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodyOf('/api/presets/reviewer', 'PUT')).toEqual({ harness: 'zen-agent', config: { persona: 'ops-lead' } }));
    expect(calls.some((c) => c.url === '/api/presets/coo' && c.init?.method === 'PUT')).toBe(false);
  });

  it('refuses a name that is already taken instead of overwriting it', async () => {
    presets = [
      { name: 'coo', harness: 'zen-agent', config: {}, updated_at: 'x' },
      { name: 'quick', harness: 'claude-code', config: {}, updated_at: 'x' },
    ];
    mount();
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.click(screen.getByRole('button', { name: 'Preset settings' }));
    fireEvent.change(await screen.findByLabelText('Preset name'), { target: { value: 'quick' } });
    expect(await screen.findByText(/already exists|exists/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the launch error beside the button and points at the settings', async () => {
    presets = [{ name: 'default', harness: 'zen-agent', config: { model: 'gone/model' }, updated_at: 'x' }];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
      if (url === '/api/presets') return json({ presets });
      if (url === '/api/zen/chats' && init?.method === 'POST') return json({ error: { message: 'unknown model gone/model' } }, 400);
      return json({ error: { message: 'no' } }, 404);
    }));
    mount();
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.click(screen.getByRole('button', { name: /start a chat from the preset/i }));
    expect(await screen.findByText(/unknown model gone\/model/)).toBeTruthy();
  });
});
