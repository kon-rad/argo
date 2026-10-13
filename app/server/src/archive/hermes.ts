import { DatabaseSync } from 'node:sqlite';
import { clean, sha256 } from './clean.js';
import type { Host, ParsedMessage, SessionInput } from './types.js';

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const epoch = (v: unknown): Date | null => { const n = num(v); return n === null ? null : new Date(n * 1000); };

// Columns lifted into typed fields; everything else goes to meta. SELECT * so a
// Hermes version with more or fewer columns (Mac vs droplet) still reads.
const SESSION_FIELDS = new Set(['id', 'parent_session_id', 'cwd', 'title', 'model', 'started_at', 'ended_at',
  'message_count', 'input_tokens', 'output_tokens', 'estimated_cost_usd', 'actual_cost_usd']);

export function readHermes(dbPath: string, host: Host): {
  sessions: SessionInput[];
  messages: Array<ParsedMessage & { sessionExternalId: string }>;
} {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sessions = (db.prepare('SELECT * FROM sessions ORDER BY started_at').all() as Row[]).map((r): SessionInput => {
      const meta: Row = {};
      for (const [k, v] of Object.entries(r)) if (!SESSION_FIELDS.has(k)) meta[k] = typeof v === 'bigint' ? Number(v) : v;
      return {
        source: 'hermes', host, externalId: String(r.id), parentExternalId: str(r.parent_session_id),
        project: str(r.cwd), title: str(r.title), model: str(r.model),
        startedAt: epoch(r.started_at), endedAt: epoch(r.ended_at),
        messageCount: num(r.message_count), inputTokens: num(r.input_tokens), outputTokens: num(r.output_tokens),
        costUsd: num(r.actual_cost_usd) ?? num(r.estimated_cost_usd),
        meta: clean(meta), b2Path: null,
      };
    });

    const messages = (db.prepare('SELECT * FROM messages ORDER BY id').all() as Row[]).map((r) => {
      const raw: Row = {};
      for (const [k, v] of Object.entries(r)) raw[k] = typeof v === 'bigint' ? Number(v) : v;
      const parts = [str(r.content), str(r.reasoning) && `[reasoning] ${r.reasoning}`, str(r.tool_calls) && `[tool_calls] ${r.tool_calls}`];
      const id = num(r.id)!;
      const json = JSON.stringify(raw);
      return {
        sessionExternalId: String(r.session_id),
        seq: id, externalId: `msg:${id}`, parentExternalId: null,
        role: String(r.role), kind: String(r.role), ts: epoch(r.timestamp),
        contentText: clean(parts.filter(Boolean).join('\n')),
        raw: clean(raw), rawSha: sha256(json), isSidechain: false,
      };
    });
    return { sessions, messages };
  } finally {
    db.close();
  }
}
