import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { StreamEvent } from '../lib/api.js';

/**
 * Renders an agent's event log as a conversation: your messages, the agent's text, its thinking folded, each tool
 * call as a card with its result underneath, a guard block in warning colour, and a line per finished turn. Two
 * logs speak here: Claude Code's stream-json (the Chat tab and a board task's live log, via agent-hub) and
 * zen-agent's trace (`zen-agent serve`: meta, message, tool, blocked, compaction, end, plus live deltas). The two
 * vocabularies do not overlap, so one pass sorts both into the same items.
 */

type Item =
  | { kind: 'you'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; input: unknown; result?: string; error?: boolean; ms?: number }
  | { kind: 'blocked'; name: string; reason: string }
  | { kind: 'note'; text: string }
  | { kind: 'turn'; ok: boolean; text: string };

type Block = { type?: string; text?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean;
  thinking?: string; redacted?: boolean; arguments?: unknown };

const GENERIC_KEYS = ['command', 'path', 'file_path', 'query', 'q', 'name', 'skill', 'objective', 'title', 'url', 'text', 'message', 'note'];

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
    : pick(...GENERIC_KEYS);
  return (s ?? JSON.stringify(i)).replace(/\s+/g, ' ').slice(0, 160);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: Block) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`)).join('\n');
  }
  return JSON.stringify(content);
}

const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

export function toItems(events: StreamEvent[]): { items: Item[]; typing: string; thinking: string } {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: 'tool' }>>();
  let typing = '';
  let thinking = '';
  const sessions = new Set<string>();   // the CLI repeats system/init every turn; note each session once
  const addTool = (id: string, name: string, input: unknown) => {
    const t = { kind: 'tool' as const, id, name, summary: toolSummary(name, input), input };
    tools.set(id, t);
    items.push(t);
  };
  for (const ev of events) {
    const msg = (ev.message ?? {}) as { role?: string; content?: Block[] | string; toolCallId?: string; toolName?: string; isError?: boolean };
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
          if (b.type === 'tool_use' && b.id) addTool(b.id, b.name ?? 'tool', b.input);
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

      // zen-agent: the trace, live.
      case 'meta': {
        const who = typeof ev.persona === 'string' && ev.persona ? ev.persona : 'default persona';
        const n = Array.isArray(ev.tools) ? ev.tools.length : 0;
        items.push({ kind: 'note', text: `${ev.resumed ? 'session resumed' : 'session started'} · ${who} on ${String(ev.model ?? '')} · ${n} tool${n === 1 ? '' : 's'}` });
        break;
      }
      case 'delta':
        if (typeof ev.text === 'string') typing += ev.text;
        if (typeof ev.thinking === 'string') thinking += ev.thinking;
        break;
      case 'message': {
        const blocks: Block[] = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg.content) ? msg.content : [];
        if (msg.role === 'user') {
          const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
          if (text) items.push({ kind: 'you', text });
        } else if (msg.role === 'assistant') {
          typing = '';
          thinking = '';
          for (const b of blocks) {
            if (b.type === 'thinking') items.push({ kind: 'thinking', text: b.redacted ? '(redacted)' : b.thinking ?? '' });
            else if (b.type === 'text' && b.text?.trim()) items.push({ kind: 'text', text: b.text });
            else if (b.type === 'toolCall' && b.id) addTool(b.id, b.name ?? 'tool', b.arguments);
          }
        } else if (msg.role === 'toolResult' && msg.toolCallId && tools.has(msg.toolCallId)) {
          const t = tools.get(msg.toolCallId)!;
          t.result = resultText(msg.content);
          t.error = Boolean(msg.isError);
        }
        break;
      }
      case 'tool': {
        const t = typeof ev.toolCallId === 'string' ? tools.get(ev.toolCallId) : undefined;
        if (t) {
          if (typeof ev.durationMs === 'number') t.ms = ev.durationMs;
          if (ev.isError === true) t.error = true;
        }
        break;
      }
      case 'blocked':
        items.push({ kind: 'blocked', name: String(ev.name ?? 'tool'), reason: String(ev.reason ?? '') });
        break;
      case 'compaction':
        items.push({ kind: 'note', text: `compacted ${fmtTokens(Number(ev.before ?? 0))} → ${fmtTokens(Number(ev.after ?? 0))} tokens · ${String(ev.dropped ?? 0)} messages dropped` });
        break;
      case 'steer':
        items.push({ kind: 'note', text: `steer: ${String(ev.text ?? '')}` });
        break;
      case 'end': {
        const u = (ev.usage ?? {}) as { total?: number; cost?: number };
        const stopped = String(ev.stopped ?? 'ended');
        const bits = [stopped, `${String(ev.turns ?? 0)} turns`];
        if (typeof u.total === 'number') bits.push(`${fmtTokens(u.total)} tokens`);
        if (typeof u.cost === 'number' && u.cost > 0) bits.push(`$${u.cost.toFixed(4)}`);
        if (typeof ev.error === 'string' && ev.error) bits.push(ev.error);
        items.push({ kind: 'turn', ok: stopped === 'done', text: bits.join(' · ') });
        typing = '';
        thinking = '';
        break;
      }
      case 'error':
        items.push({ kind: 'turn', ok: false, text: `error · ${String(ev.text ?? '')}` });
        break;
    }
  }
  return { items, typing, thinking };
}

export default function EventFeed({ events, working, accent = 'var(--claude)' }: { events: StreamEvent[]; working?: boolean; accent?: string }) {
  const { items, typing, thinking } = toItems(events);
  return (
    <ol className="space-y-2">
      {items.map((it, i) => (
        <FeedItem key={i} it={it} accent={accent} />
      ))}
      {thinking && (
        <li className="whitespace-pre-wrap text-sm italic text-[var(--ink-dim)]">{thinking}</li>
      )}
      {typing && (
        <li className="prose max-w-none text-[0.95rem]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{typing}</ReactMarkdown>
        </li>
      )}
      {working && !typing && !thinking && <li className="animate-pulse text-sm text-[var(--ink-dim)]">working…</li>}
    </ol>
  );
}

function FeedItem({ it, accent }: { it: Item; accent: string }) {
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
    case 'thinking':
      return (
        <li>
          <details className="text-xs text-[var(--ink-dim)]">
            <summary className="cursor-pointer italic">thinking <span className="text-[var(--ink-faint)]">{it.text.replace(/\s+/g, ' ').slice(0, 100)}</span></summary>
            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words italic">{it.text}</pre>
          </details>
        </li>
      );
    case 'tool':
      return (
        <li>
          <details className="rounded border border-[var(--rule)] px-2 py-1 text-xs">
            <summary className="cursor-pointer">
              <b className="font-semibold" style={{ color: accent }}>{it.name}</b>{' '}
              <code className="break-all text-[var(--ink-dim)]">{it.summary}</code>
              {it.result === undefined && !it.error ? <span className="ml-1 animate-pulse text-[var(--ink-faint)]">…</span>
                : it.error ? <span className="ml-1 text-[var(--warn)]">error</span> : <span className="ml-1 text-[var(--ink-faint)]">✓</span>}
              {typeof it.ms === 'number' && <span className="ml-1 text-[var(--ink-faint)]">{it.ms >= 1000 ? `${(it.ms / 1000).toFixed(1)} s` : `${it.ms} ms`}</span>}
            </summary>
            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[var(--ink-dim)]">{JSON.stringify(it.input, null, 2)}</pre>
            {it.result !== undefined && (
              <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-[var(--rule)] pt-1">{it.result.slice(0, 20000)}</pre>
            )}
          </details>
        </li>
      );
    case 'blocked':
      return (
        <li className="rounded border border-[var(--warn)] px-2 py-1 text-xs text-[var(--warn)]" role="note">
          <b className="font-semibold">blocked</b> <code>{it.name}</code> · {it.reason}
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
