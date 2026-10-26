import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ChatPanel from '../src/components/chat/ChatPanel.js';

const OPTIONS = {
  providers: [
    { id: 'anthropic', label: 'Anthropic', configured: false, env: 'ANTHROPIC_API_KEY', default: 'claude-opus-5-5', models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }] },
    { id: 'together', label: 'Together AI', configured: true, env: 'TOGETHER_API_KEY', default: 'm1', models: [{ id: 'm1', label: 'Model one' }, { id: 'm2', label: 'Model two' }] },
  ],
  default_provider: 'anthropic',
  default_system_prompt: 'DEFAULT PROMPT',
  personas: [
    { id: 'default', name: 'Second brain', role: 'assistant', team: null, builtin: true },
    { id: 'ada', name: 'ada', role: 'Researcher', team: 'research', builtin: false },
  ],
  settings: {
    provider: null, model: null, persona: 'default', system_prompt: null, retrieval: { top_k: 8, multi_query: true, rerank: false },
    resolved: { provider: 'together', model: 'm1', system_prompt: 'DEFAULT PROMPT', rerank_available: false, embeddings: true },
  },
  embeddings: { chunks: 120, model: 'fake', configured: true },
  rerank: { available: false, model: 'x' },
};

const CONVERSATION = { id: 7, title: 'Heaters', persona: 'default', provider: null, model: null, created_at: '2026-10-24T09:00:00Z', updated_at: '2026-10-24T09:00:00Z', message_count: 2 };
const MESSAGES = [
  { id: 1, conversation_id: 7, role: 'user', content: 'Which heater?', sources: [], meta: {}, created_at: '2026-10-24T09:00:00Z' },
  {
    id: 2, conversation_id: 7, role: 'assistant', content: 'The electric one [1].',
    sources: [{ n: 1, path: 'Areas/heater.md', title: 'Garage Heater', heading_path: 'Decision', chunk_from: 0, chunk_to: 1, score: 0.5, snippet: 'We picked the electric unit.' }],
    meta: { provider: 'together', model: 'm1', persona: 'default', retrieval: { vector: true } }, created_at: '2026-10-24T09:00:01Z',
  },
];

const calls: { url: string; init?: RequestInit }[] = [];

function sse(blocks: [string, unknown][]): Response {
  const text = blocks.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(new TextEncoder().encode(text), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('/api/chat/options')) return json(OPTIONS);
      if (url.startsWith('/api/chat/settings')) return json({ settings: OPTIONS.settings });
      if (url === '/api/chat/conversations' && init?.method === 'POST') return json({ conversation: { ...CONVERSATION, id: 8, title: 'New conversation', message_count: 0 } }, 201);
      if (url === '/api/chat/conversations') return json({ conversations: [CONVERSATION] });
      if (url === '/api/chat/conversations/7') return json({ conversation: CONVERSATION, messages: MESSAGES });
      // The stream finishes at once under test, so the new conversation shows its stored turns right after.
      if (url === '/api/chat/conversations/8') {
        const sent = calls.some((c) => c.url === '/api/chat/conversations/8/messages');
        return json({
          conversation: { ...CONVERSATION, id: 8, title: 'New conversation' },
          messages: sent ? [{ ...MESSAGES[0], id: 11, content: 'Which heater did I pick?' }, { ...MESSAGES[1], id: 12, content: 'Streamed answer [1].' }] : [],
        });
      }
      if (url.endsWith('/messages') && init?.method === 'POST') {
        return sse([
          ['sources', { sources: MESSAGES[1]!.sources, queries: ['q'], vector: true, keyword: true, reranked: false, ms: 5 }],
          ['delta', { text: 'Streamed ' }],
          ['delta', { text: 'answer [1].' }],
          ['done', { message: { ...MESSAGES[1], id: 9, content: 'Streamed answer [1].' }, conversation: CONVERSATION }],
        ]);
      }
      if (url.startsWith('/api/file/resolve')) return json({ resolved: {} });
      return json({});
    }),
  );
}

function mount(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><ChatPanel onClose={onClose} /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  calls.length = 0;
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ChatPanel', () => {
  it('lists conversations on the left, starts on a fresh one, and shows the resolved model', async () => {
    mount();
    await screen.findByText('Heaters');
    const list = screen.getByRole('list', { name: 'Conversations' });
    expect(within(list).getByText('Heaters')).toBeTruthy();
    expect(await screen.findByText('Ask your second brain', { selector: 'p' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Together AI · m1/ })).toBeTruthy();
    expect((screen.getByLabelText('Persona') as HTMLSelectElement).value).toBe('default');
  });

  it('opens a conversation and renders its answer with citation links and sources', async () => {
    mount();
    fireEvent.click(await screen.findByText('Heaters'));
    await screen.findByText('Which heater?');
    const cite = await screen.findByRole('link', { name: '1' });
    expect(cite.getAttribute('href')).toBe('/file/Areas/heater.md');
    fireEvent.click(screen.getByRole('button', { name: /1 source/ }));
    expect(screen.getByRole('link', { name: 'Garage Heater' })).toBeTruthy();
    expect(screen.getByText('We picked the electric unit.')).toBeTruthy();
  });

  it('creates a conversation on the first send and streams the answer in', async () => {
    mount();
    const box = await screen.findByLabelText('Ask a question');
    fireEvent.change(box, { target: { value: 'Which heater did I pick?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/chat/conversations' && c.init?.method === 'POST')).toBe(true));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/chat/conversations/8/messages')).toBe(true));
    const send = calls.find((c) => c.url === '/api/chat/conversations/8/messages')!;
    expect(JSON.parse(send.init!.body as string)).toEqual({ content: 'Which heater did I pick?', persona: 'default' });
    expect(await screen.findByText('Which heater did I pick?')).toBeTruthy();
    await screen.findByText(/Streamed answer/);
  });

  it('opens the settings from the model chip, lists only configured providers as pickable, and saves', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Together AI · m1/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Chat settings' });
    const provider = within(dialog).getByLabelText('Provider') as HTMLSelectElement;
    expect(provider.value).toBe('together');
    expect((within(dialog).getByRole('option', { name: /Anthropic/ }) as HTMLOptionElement).disabled).toBe(true);
    const model = within(dialog).getByLabelText('Model') as HTMLSelectElement;
    fireEvent.change(model, { target: { value: 'm2' } });
    fireEvent.change(within(dialog).getByLabelText('Persona'), { target: { value: 'ada' } });
    fireEvent.change(within(dialog).getByLabelText('System prompt'), { target: { value: 'MY PROMPT' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/chat/settings' && c.init?.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.url === '/api/chat/settings' && c.init?.method === 'PUT')!;
    expect(JSON.parse(put.init!.body as string)).toEqual({
      provider: 'together', model: 'm2', persona: 'ada', system_prompt: 'MY PROMPT', retrieval: { top_k: 8, multi_query: true, rerank: false },
    });
  });

  it('closes on Escape and on the close button', async () => {
    const onClose = vi.fn();
    mount(onClose);
    await screen.findByText('Heaters');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close chat' })[0]!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('ChatSettingsModal with connected machines', () => {
  it('offers discovered machine models and marks an offline machine', async () => {
    const { default: ChatSettingsModal } = await import('../src/components/chat/ChatSettingsModal.js');
    const options = {
      ...OPTIONS,
      providers: [
        ...OPTIONS.providers,
        { id: 'ollama-box1', label: 'Ollama · box1', configured: true, env: null, machine: true, default: 'qwen3:8b', models: [{ id: 'qwen3:8b', label: 'qwen3:8b' }, { id: 'hf.co/acme/chat-gguf:Q4_K_M', label: 'hf.co/acme/chat-gguf:Q4_K_M' }] },
        { id: 'ollama-box2', label: 'Ollama · box2', configured: false, env: null, machine: true, offline: true, default: '', models: [] },
      ],
      settings: { ...OPTIONS.settings, provider: 'ollama-box1', model: 'qwen3:8b' },
    };
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <ChatSettingsModal options={options as never} onClose={() => {}} />
      </QueryClientProvider>,
    );
    const offline = screen.getByRole('option', { name: 'Ollama · box2 (offline)' }) as HTMLOptionElement;
    expect(offline.disabled).toBe(true);
    expect(screen.getByRole('option', { name: 'Anthropic (set ANTHROPIC_API_KEY)' })).toBeTruthy();
    const modelSelect = screen.getByLabelText('Model');
    expect(within(modelSelect).getByRole('option', { name: 'hf.co/acme/chat-gguf:Q4_K_M' })).toBeTruthy();
    cleanup();
  });
});
