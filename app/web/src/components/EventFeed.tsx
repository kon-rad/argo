import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { StreamEvent } from '../lib/api.js';

/**
 * Renders a Claude Code stream-json log as a conversation: your messages, Claude's text, each tool call as a card
 * with its result folded underneath, and a line per finished turn. Used by the Chat tab (live, with text deltas for
 * the reply being typed) and by a board task's live log (cc-dispatcher workers).
 */

type Item =
  | { kind: 'you'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; input: unknown; result?: string; error?: boolean }
  | { kind: 'note'; text: string }
  | { kind: 'turn'; ok: boolean; text: string };

type Block = { type?: string; text?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.map((k) => i[k]).find((v) => typeof v === 'string') as string | undefined;
  const s =
    name === 'Bash' ? pick('command')
    : ['Read', 'Edit', 'Write', 'NotebookEdit'].includes(name) ? pick('file_path', 'notebook_path')
    : ['Grep', 'Glob'].includes(name) ? pick('pattern')
    : name === 'WebSearch' ? pick('query')
    : name === 'WebFetch' ? pick('url')
    : ['Task', 'Agent'].includes(name) ? pick('description', 'prompt')
    : undefined;
  return (s ?? JSON.stringify(i)).replace(/\s+/g, ' ').slice(0, 160);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: Block) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`)).join('\n');
  }
  return JSON.stringify(content);
}

export function toItems(events: StreamEvent[]): { items: Item[]; typing: string } {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: 'tool' }>>();
  let typing = '';
  const sessions = new Set<string>();   // the CLI repeats system/init every turn; note each session once
  for (const ev of events) {
    const msg = (ev.message ?? {}) as { content?: Block[] | string };
    switch (ev.type) {
      case 'you':
        items.push({ kind: 'you', text: String(ev.text ?? '') });
        break;
      case 'stream_event': {
        const delta = ((ev.event as { delta?: { type?: string; text?: string } }) ?? {}).delta;
        if (delta?.type === 'text_delta') typing += delta.text ?? '';
        break;
      }
      case 'assistant':
        typing = '';   // the full message supersedes its deltas
        for (const b of Array.isArray(msg.content) ? msg.content : []) {
          if (b.type === 'text' && b.text?.trim()) items.push({ kind: 'text', text: b.text });
          if (b.type === 'tool_use' && b.id) {
            const t = { kind: 'tool' as const, id: b.id, name: b.name ?? 'tool', summary: toolSummary(b.name ?? '', b.input), input: b.input };
            tools.set(b.id, t);
            items.push(t);
          }
        }
        break;
      case 'user':   // tool results come back as user messages
        for (const b of Array.isArray(msg.content) ? msg.content : []) {
          if (b.type === 'tool_result' && b.tool_use_id && tools.has(b.tool_use_id)) {
            const t = tools.get(b.tool_use_id)!;
            t.result = resultText(b.content);
            t.error = Boolean(b.is_error);
          }
        }
        break;
      case 'result': {
        const secs = typeof ev.duration_ms === 'number' ? ` · ${(ev.duration_ms / 1000).toFixed(1)} s` : '';
        const ok = ev.subtype === 'success' && !ev.is_error;
        items.push({ kind: 'turn', ok, text: `${ok ? 'done' : String(ev.subtype ?? 'ended')}${secs}` });
        typing = '';
        break;
      }
      case 'system':
        if (ev.subtype === 'init' && !sessions.has(String(ev.session_id))) {
          sessions.add(String(ev.session_id));
          items.push({ kind: 'note', text: `${sessions.size > 1 ? 'session resumed' : 'session started'} · ${String(ev.model ?? '')}` });
        }
        if (ev.subtype === 'api_retry') items.push({ kind: 'note', text: `retrying the API (${String(ev.error ?? '')})` });
        if (ev.subtype === 'permission_denied') items.push({ kind: 'note', text: 'a tool call was denied (no one to approve it here)' });
        break;
      case 'hub':
      case 'stderr':
      case 'raw':
        items.push({ kind: 'note', text: String(ev.text ?? '') });
        break;
    }
  }
  return { items, typing };
}

export default function EventFeed({ events, working }: { events: StreamEvent[]; working?: boolean }) {
  const { items, typing } = toItems(events);
  return (
    <ol className="space-y-2">
      {items.map((it, i) => (
        <FeedItem key={i} it={it} />
      ))}
      {typing && (
        <li className="prose max-w-none text-[0.95rem]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{typing}</ReactMarkdown>
        </li>
      )}
      {working && !typing && <li className="animate-pulse text-sm text-[var(--ink-dim)]">working…</li>}
    </ol>
  );
}

function FeedItem({ it }: { it: Item }) {
  switch (it.kind) {
    case 'you':
      return (
        <li className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-[var(--paper-sunk)] px-3 py-2 text-[0.95rem]">{it.text}</li>
      );
    case 'text':
      return (
        <li className="prose max-w-none text-[0.95rem]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{it.text}</ReactMarkdown>
        </li>
      );
    case 'tool':
      return (
        <li>
          <details className="rounded border border-[var(--rule)] px-2 py-1 text-xs">
            <summary className="cursor-pointer">
              <b className="font-semibold" style={{ color: 'var(--claude)' }}>{it.name}</b>{' '}
              <code className="break-all text-[var(--ink-dim)]">{it.summary}</code>
              {it.result === undefined ? <span className="ml-1 animate-pulse text-[var(--ink-faint)]">…</span>
                : it.error ? <span className="ml-1 text-[var(--warn)]">error</span> : <span className="ml-1 text-[var(--ink-faint)]">✓</span>}
            </summary>
            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[var(--ink-dim)]">{JSON.stringify(it.input, null, 2)}</pre>
            {it.result !== undefined && (
              <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-[var(--rule)] pt-1">{it.result.slice(0, 20000)}</pre>
            )}
          </details>
        </li>
      );
    case 'note':
      return <li className="text-center text-xs text-[var(--ink-faint)]">{it.text}</li>;
    case 'turn':
      return (
        <li className="text-xs" style={{ color: it.ok ? 'var(--hermes)' : 'var(--warn)' }}>— {it.text}</li>
      );
  }
}
