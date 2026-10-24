import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { clipOutput, text, tool, type ToolContext } from './index.js';

/**
 * The knowledge base: the second brain's retrieval API. `/api/search` is the
 * hybrid (keyword + vector, reciprocal rank fusion) note search the app's own
 * search box uses, `/api/search/global` adds database records and agent
 * transcripts, and `/api/file/source` returns a note's markdown. The server
 * wants the owner's session cookie: put it in the variable `headersEnv`
 * names as a JSON object of headers; a local app with no login needs none.
 */
export interface SearchHit {
  ref_path: string;
  title: string | null;
  snippet: string;
  heading_path?: string | null;
  similarity?: number | null;
  match_kind?: string;
}

export class Knowledge {
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly fetchFn: typeof fetch,
  ) {}

  static fromEnv(cfg: { url: string; headersEnv: string }, env: NodeJS.ProcessEnv, fetchFn: typeof fetch): Knowledge {
    let headers: Record<string, string> = {};
    const raw = env[cfg.headersEnv];
    if (raw) {
      try {
        headers = JSON.parse(raw) as Record<string, string>;
      } catch {
        throw new Error(`${cfg.headersEnv} must be a JSON object of HTTP headers`);
      }
    }
    return new Knowledge(cfg.url.replace(/\/+$/, ''), headers, fetchFn);
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    const res = await this.fetchFn(`${this.url}${path}?${q}`, { headers: { Accept: 'application/json', ...this.headers }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null;
      const msg = typeof body?.error === 'string' ? body.error : body?.error?.message;
      throw new Error(`knowledge base ${res.status}${msg ? `: ${msg}` : ''}${res.status === 401 ? ' (set the session cookie in the headers variable)' : ''}`);
    }
    return (await res.json()) as T;
  }

  search(q: string, opts: { mode?: 'keyword' | 'semantic' | 'hybrid'; limit?: number } = {}): Promise<{ results: SearchHit[]; total: number; mode: string }> {
    return this.get('/api/search', { q, mode: opts.mode ?? 'hybrid', limit: opts.limit ?? 8 });
  }

  global(q: string, opts: { scopes?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    return this.get('/api/search/global', { q, scopes: opts.scopes, limit: opts.limit ?? 5 });
  }

  note(path: string): Promise<{ path: string; content: string }> {
    return this.get('/api/file/source', { path });
  }
}

export function formatHits(hits: SearchHit[]): string {
  if (!hits.length) return 'no matches';
  return hits
    .map((h, i) => {
      const where = h.heading_path ? ` › ${h.heading_path}` : '';
      const score = typeof h.similarity === 'number' ? ` (${h.similarity.toFixed(2)})` : '';
      return `[${i + 1}] ${h.ref_path}${where}${score}\n    ${h.snippet.replace(/\s+/g, ' ').slice(0, 300)}`;
    })
    .join('\n');
}

export function knowledgeTools(ctx: ToolContext): AgentTool<any>[] {
  const k = ctx.cfg.knowledge;
  if (k.kind !== 'secondbrain') return [];
  const kb = Knowledge.fromEnv(k, ctx.env, ctx.fetch);

  const search_notes = tool({
    name: 'search_notes',
    label: 'Search notes',
    description: 'Search the vault with hybrid retrieval (keywords and meaning). Returns ranked passages with their note paths; read a note with read_note.',
    parameters: Type.Object({
      query: Type.String(),
      mode: Type.Optional(Type.Union([Type.Literal('hybrid'), Type.Literal('keyword'), Type.Literal('semantic')])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    execute: async (a) => {
      const r = await kb.search(a.query, a);
      return text(`${r.total} matches (${r.mode})\n${formatHits(r.results)}`, { total: r.total, mode: r.mode });
    },
  });

  const search_everything = tool({
    name: 'search_everything',
    label: 'Search records and transcripts',
    description: 'One search over notes, database records (projects, org messages, facts) and past agent transcripts. Scopes: notes, records, agents.',
    parameters: Type.Object({
      query: Type.String(),
      scopes: Type.Optional(Type.String({ description: 'Comma list, default all available' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    execute: async (a) => {
      const r = await kb.global(a.query, a);
      const sections: string[] = [];
      for (const scope of ['notes', 'records', 'agents']) {
        const s = r[scope] as { results?: unknown[]; total?: number; error?: string } | undefined;
        if (!s) continue;
        if (s.error) {
          sections.push(`## ${scope}: unavailable (${s.error})`);
          continue;
        }
        const items = (s.results ?? []).map((x) => JSON.stringify(x)).join('\n');
        sections.push(`## ${scope} (${s.total ?? 0})\n${items || 'none'}`);
      }
      return text(clipOutput(sections.join('\n\n') || 'nothing', ctx.cfg.shell.maxOutput), {});
    },
  });

  const read_note = tool({
    name: 'read_note',
    label: 'Read note',
    description: 'Read a note from the knowledge base by its vault path (as returned by search_notes).',
    parameters: Type.Object({ path: Type.String() }),
    execute: async (a) => {
      const r = await kb.note(a.path);
      return text(clipOutput(r.content, ctx.cfg.shell.maxOutput * 3), { path: r.path });
    },
  });

  return [search_notes, search_everything, read_note];
}
