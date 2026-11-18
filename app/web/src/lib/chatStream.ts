import { ApiError, AUTH_EXPIRED_EVENT, type ChatConversation, type ChatMessage, type ChatSource } from './api.js';

export interface SourcesEvent {
  sources: ChatSource[];
  queries: string[];
  vector: boolean;
  keyword: boolean;
  reranked: boolean;
  ms: number;
}

export interface StreamHandlers {
  onSources(e: SourcesEvent): void;
  onDelta(text: string): void;
  onDone(e: { message: ChatMessage; conversation: ChatConversation }): void;
  onError(message: string): void;
}

/**
 * Sends one message and follows the server-sent events it answers with:
 * `sources` once retrieval is done, `delta` per piece of text, then `done`
 * (or `error`). Plain fetch rather than EventSource, which cannot POST.
 */
export async function sendChatMessage(
  conversationId: number,
  body: { content: string; provider?: string; model?: string; persona?: string },
  h: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/chat/conversations/${conversationId}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401) window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiError(res.status, err?.error?.message ?? `${res.status} ${res.statusText}`);
  }
  if (!res.body) throw new ApiError(0, 'empty response');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const handle = (block: string): void => {
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (event === 'sources') h.onSources(parsed as SourcesEvent);
    else if (event === 'delta') h.onDelta((parsed as { text: string }).text);
    else if (event === 'done') h.onDone(parsed as { message: ChatMessage; conversation: ChatConversation });
    else if (event === 'error') h.onError((parsed as { message: string }).message);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep).replace(/^\r?\n\r?\n/, '');
      handle(block);
    }
  }
  if (buf.trim()) handle(buf);
}
