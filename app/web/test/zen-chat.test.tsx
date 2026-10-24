import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ZenChat from '../src/routes/agents/ZenChat.js';
import { toItems } from '../src/components/EventFeed.js';

const CATALOG = {
  providers: [
    { id: 'anthropic', name: 'Anthropic', custom: false, configured: true, key_env: null, key_name: 'Anthropic API key', base_url: null, reachable: null },
    { id: 'openai', name: 'OpenAI', custom: false, configured: false, key_env: null, key_name: 'OpenAI API key', base_url: null, reachable: null },
    { id: 'm1-qwen', name: 'm1-qwen', custom: true, configured: true, key_env: 'M1_LLAMA_KEY', key_name: 'm1-qwen API key', base_url: 'http://laptop.example:8080/v1', reachable: true },
    { id: 'm1-asleep', name: 'm1-asleep', custom: true, configured: true, key_env: null, key_name: 'm1-asleep API key', base_url: 'http://other.example:8080/v1', reachable: false },
  ],
  models: [
    { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', context_window: 200000, reasoning: true, configured: true, reachable: null },
    { provider: 'openai', id: 'gpt-5', name: 'GPT-5', context_window: 400000, reasoning: true, configured: false, reachable: null },
    { provider: 'm1-qwen', id: 'qwen3.6-9b', name: 'qwen3.6-9b', context_window: 131072, reasoning: false, configured: true, reachable: true },
    { provider: 'm1-asleep', id: 'qwen-asleep', name: 'qwen-asleep', context_window: 32000, reasoning: false, configured: true, reachable: false },
  ],
};
const PERSONAS = { personas: [{ name: 'atlas', role: 'Researcher', team: 'research', runtime: 'zen-agent' }] };
const CHAT = {
  id: 'abcdefabcdef', title: 'What does hello.txt say?', session_id: 'atlas-20261024-1', persona: 'atlas', model: 'anthropic/claude-sonnet-4-6',
  tools: ['fs', 'shell', 'skills'], thinking: 'low', from: null, created_at: '2026-10-24T09:00:00Z', updated_at: '2026-10-24T09:01:00Z',
  status: 'idle', error: null, turns: 2, usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, total: 1200, cost: 0.0123 },
};
const EVENTS = [
  { type: 'meta', at: '2026-10-24T09:00:00Z', id: 'atlas-20261024-1', persona: 'atlas', model: 'anthropic/claude-sonnet-4-6', tools: ['read_file', 'bash', 'read_skill'], resumed: null },
  { type: 'message', at: '2026-10-24T09:00:01Z', message: { role: 'user', content: 'What does hello.txt say?', timestamp: 1 } },
  { type: 'delta', at: '2026-10-24T09:00:02Z', thinking: 'Let me look.' },
  { type: 'message', at: '2026-10-24T09:00:03Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Let me look at the file first.' }, { type: 'toolCall', id: 'c1', name: 'read_file', arguments: { path: 'hello.txt' } }], stopReason: 'toolUse' } },
  { type: 'message', at: '2026-10-24T09:00:04Z', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'read_file', content: [{ type: 'text', text: 'hello\nworld' }], isError: false, timestamp: 2 } },
  { type: 'tool', at: '2026-10-24T09:00:04Z', toolCallId: 'c1', name: 'read_file', args: { path: 'hello.txt' }, isError: false, durationMs: 1234 },
  { type: 'message', at: '2026-10-24T09:00:05Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'cat .env' } }], stopReason: 'toolUse' } },
  { type: 'blocked', at: '2026-10-24T09:00:05Z', name: 'bash', reason: 'guard: that would print or copy a secrets file' },
  { type: 'message', at: '2026-10-24T09:00:05Z', message: { role: 'toolResult', toolCallId: 'c2', toolName: 'bash', content: [{ type: 'text', text: 'guard: that would print or copy a secrets file' }], isError: true, timestamp: 3 } },
  { type: 'compaction', at: '2026-10-24T09:00:06Z', before: 81200, after: 14900, dropped: 37 },
  { type: 'message', at: '2026-10-24T09:00:07Z', message: { role: 'assistant', content: [{ type: 'text', text: 'It says **hello world**.' }], stopReason: 'stop' } },
  { type: 'end', at: '2026-10-24T09:00:08Z', stopped: 'done', turns: 3, usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, total: 1200, cost: 0.0123 } },
];

const calls: { url: string; init?: RequestInit }[] = [];

function stubFetch(chats = [CHAT]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/zen/models') return json(CATALOG);
      if (url === '/api/zen/personas') return json(PERSONAS);
      if (url === '/api/zen/chats' && init?.method === 'POST') return json({ ...CHAT, id: '0123456789ab', title: '', status: 'idle' });
      if (url === '/api/zen/chats') return json({ chats });
      if (url.startsWith('/api/zen/chats/abcdefabcdef/events')) return json({ events: EVENTS, offset: EVENTS.length, size: EVENTS.length, epoch: 'e1', chat: CHAT });
      if (url.startsWith('/api/zen/chats/0123456789ab/events')) return json({ events: [EVENTS[0]], offset: 1, size: 1, epoch: 'e1', chat: { ...CHAT, id: '0123456789ab', title: '' } });
      return json({ error: { message: `unexpected ${url}` } }, 404);
    }),
  );
}

function mount(path = '/agents/zen') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/agents/zen" element={<ZenChat />} />
          <Route path="/agents/zen/:chatId" element={<ZenChat />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ZenChat', () => {
  it('the new-session form offers personas and configured, answering models; a local endpoint starts read-only', async () => {
    stubFetch();
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'New session' }));
    const model = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    await waitFor(() => expect(model.value).toBe('anthropic/claude-sonnet-4-6'));
    const options = within(model).getAllByRole('option') as HTMLOptionElement[];
    const byValue = Object.fromEntries(options.map((o) => [o.value, o]));
    expect(byValue['openai/gpt-5']!.disabled).toBe(true);
    expect(byValue['openai/gpt-5']!.textContent).toMatch(/no key on the server/);
    expect(byValue['m1-asleep/qwen-asleep']!.disabled).toBe(true);
    expect(byValue['m1-asleep/qwen-asleep']!.textContent).toMatch(/unreachable/);
    expect(byValue['m1-qwen/qwen3.6-9b']!.disabled).toBe(false);
    // The custom provider's group names the variable that backs it, never a key.
    expect(screen.getByRole('group', { name: /m1-qwen · http:\/\/laptop.example:8080\/v1 · M1_LLAMA_KEY/ })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/sk-/);

    expect((screen.getByLabelText(/full \(files/) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(model, { target: { value: 'm1-qwen/qwen3.6-9b' } });
    await waitFor(() => expect((screen.getByLabelText(/read-only/) as HTMLInputElement).checked).toBe(true));

    const persona = screen.getByLabelText('Persona') as HTMLSelectElement;
    expect(within(persona).getByRole('option', { name: /atlas · Researcher · research/ })).toBeTruthy();
    fireEvent.change(persona, { target: { value: 'atlas' } });
    fireEvent.change(screen.getByLabelText('Thinking'), { target: { value: 'medium' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/zen/chats' && c.init?.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.url === '/api/zen/chats' && c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ persona: 'atlas', model: 'm1-qwen/qwen3.6-9b', tools: 'read-only', thinking: 'medium' });
    // Then the new chat opens.
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/zen/chats/0123456789ab/events'))).toBe(true));
  });

  it('shows a session as the trace: thinking folded, tool calls with results and timing, the guard block, the end line', async () => {
    stubFetch();
    mount('/agents/zen/abcdefabcdef');
    await screen.findByText('What does hello.txt say?', { selector: 'li' });
    expect(screen.getByText(/session started · atlas on anthropic\/claude-sonnet-4-6 · 3 tools/)).toBeTruthy();
    expect(screen.getAllByText(/Let me look at the file first/).length).toBeGreaterThan(0);
    const tool = screen.getByText('read_file').closest('details')!;
    expect(tool.textContent).toMatch(/hello\.txt/);
    expect(tool.textContent).toMatch(/1\.2 s/);
    expect(tool.textContent).toMatch(/hello\nworld/);
    const blocked = screen.getByRole('note');
    expect(blocked.textContent).toMatch(/blocked.*bash.*guard: that would print or copy a secrets file/);
    expect(screen.getByText(/compacted 81\.2k → 14\.9k tokens · 37 messages dropped/)).toBeTruthy();
    expect(screen.getByText('hello world', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText(/— done · 3 turns · 1\.2k tokens · \$0\.0123/)).toBeTruthy();
    // The header says what this session is fixed to, and offers to continue it elsewhere.
    expect(screen.getByText(/atlas · anthropic\/claude-sonnet-4-6 · fs, shell, skills · thinking low/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continue as new session' }));
    expect(await screen.findByText(/Continue "What does hello.txt say\?" as a new session/)).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText('Persona') as HTMLSelectElement).value).toBe('atlas'));
    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('anthropic/claude-sonnet-4-6'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue as new session' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/zen/chats' && c.init?.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.url === '/api/zen/chats' && c.init?.method === 'POST')!;
    expect(JSON.parse(String(post.init!.body))).toMatchObject({ from: 'abcdefabcdef', persona: 'atlas', model: 'anthropic/claude-sonnet-4-6', tools: 'full', thinking: 'low' });
  });

  it('says where zen-agent runs when the server has no serve process', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'zen-agent chats run on the server: zen-agent serve is not configured on this machine (ZEN_AGENT_URL, ZEN_AGENT_TOKEN)' } }), { status: 503, headers: { 'content-type': 'application/json' } })));
    mount();
    expect(await screen.findByText(/ZEN_AGENT_URL/)).toBeTruthy();
  });
});

describe('toItems with zen-agent events', () => {
  it('sorts the trace into the shared items and keeps live deltas apart', () => {
    const { items, typing, thinking } = toItems(EVENTS as never);
    expect(items.map((i) => i.kind)).toEqual(['note', 'you', 'thinking', 'tool', 'tool', 'blocked', 'note', 'text', 'turn']);
    expect(typing).toBe('');
    expect(thinking).toBe('');
    const tools = items.filter((i) => i.kind === 'tool') as { name: string; result?: string; error?: boolean; ms?: number }[];
    expect(tools[0]).toMatchObject({ name: 'read_file', result: 'hello\nworld', error: false, ms: 1234 });
    expect(tools[1]).toMatchObject({ name: 'bash', error: true });
    const live = toItems(EVENTS.slice(0, 3) as never);
    expect(live.thinking).toBe('Let me look.');
    expect(live.items.map((i) => i.kind)).toEqual(['note', 'you']);
  });
});
