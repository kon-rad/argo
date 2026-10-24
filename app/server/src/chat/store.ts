import { z } from 'zod';
import { query } from '../db.js';

/**
 * Conversations, messages and the settings row of the chat module. Plain SQL
 * over three tables; the router owns the HTTP shapes and the streaming.
 */

export interface Conversation {
  id: number;
  title: string;
  persona: string;
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface SourceRef {
  n: number;
  path: string;
  title: string;
  heading_path: string;
  chunk_from: number;
  chunk_to: number;
  score: number;
  /** The opening of the passage, for the sources list under an answer. */
  snippet: string;
}

export interface Message {
  id: number;
  conversation_id: number;
  role: 'user' | 'assistant';
  content: string;
  sources: SourceRef[];
  meta: Record<string, unknown>;
  created_at: string;
}

const CONVERSATION_COLS = `c.id, c.title, c.persona, c.provider, c.model, c.created_at, c.updated_at,
  (SELECT count(*)::int FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count`;

export async function listConversations(limit = 200): Promise<Conversation[]> {
  const { rows } = await query<Conversation>(
    `SELECT ${CONVERSATION_COLS} FROM chat_conversations c ORDER BY c.updated_at DESC, c.id DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function getConversation(id: number): Promise<Conversation | null> {
  const { rows } = await query<Conversation>(`SELECT ${CONVERSATION_COLS} FROM chat_conversations c WHERE c.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function createConversation(input: { title?: string; persona?: string; provider?: string | null; model?: string | null }): Promise<Conversation> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO chat_conversations (title, persona, provider, model) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.title ?? 'New conversation', input.persona ?? 'default', input.provider ?? null, input.model ?? null],
  );
  return (await getConversation(rows[0]!.id))!;
}

export async function updateConversation(
  id: number,
  patch: { title?: string; persona?: string; provider?: string | null; model?: string | null; touch?: boolean },
): Promise<Conversation | null> {
  await query(
    `UPDATE chat_conversations
     SET title = coalesce($2, title), persona = coalesce($3, persona),
         provider = CASE WHEN $6 THEN $4 ELSE provider END,
         model = CASE WHEN $6 THEN $5 ELSE model END,
         updated_at = CASE WHEN $7 THEN now() ELSE updated_at END
     WHERE id = $1`,
    [id, patch.title ?? null, patch.persona ?? null, patch.provider ?? null, patch.model ?? null, patch.provider !== undefined || patch.model !== undefined, patch.touch ?? false],
  );
  return getConversation(id);
}

export async function deleteConversation(id: number): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM chat_conversations WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

export async function listMessages(conversationId: number): Promise<Message[]> {
  const { rows } = await query<Message>(
    `SELECT id, conversation_id, role, content, sources, meta, created_at
     FROM chat_messages WHERE conversation_id = $1 ORDER BY id`,
    [conversationId],
  );
  return rows;
}

export async function addMessage(input: {
  conversationId: number;
  role: 'user' | 'assistant';
  content: string;
  sources?: SourceRef[];
  meta?: Record<string, unknown>;
}): Promise<Message> {
  const { rows } = await query<Message>(
    `INSERT INTO chat_messages (conversation_id, role, content, sources, meta)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, conversation_id, role, content, sources, meta, created_at`,
    [input.conversationId, input.role, input.content, JSON.stringify(input.sources ?? []), JSON.stringify(input.meta ?? {})],
  );
  await query(`UPDATE chat_conversations SET updated_at = now() WHERE id = $1`, [input.conversationId]);
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const Retrieval = z.object({
  /** Passages handed to the model per answer. */
  top_k: z.number().int().min(1).max(20).default(8),
  /** Ask the condenser for alternate queries and fuse them. */
  multi_query: z.boolean().default(true),
  /** Cross-encoder reranking (needs RERANK_URL and RERANK_API_KEY). */
  rerank: z.boolean().default(false),
});

export const StoredSettings = z.object({
  /** A preset provider id; null: the presets' default (or the first with a key). */
  provider: z.string().nullable().default(null),
  /** A model id of that provider; null: the provider's default. */
  model: z.string().nullable().default(null),
  /** 'default' or an org agent name. */
  persona: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).default('default'),
  /** The base system prompt; null: the presets' (or the vault's) default. */
  system_prompt: z.string().max(20_000).nullable().default(null),
  retrieval: Retrieval.prefault({}),
});
export type StoredSettingsT = z.infer<typeof StoredSettings>;

/** A PUT body: every field optional, retrieval merged key by key. */
export const SettingsPatch = z
  .object({
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    persona: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).optional(),
    system_prompt: z.string().max(20_000).nullable().optional(),
    retrieval: Retrieval.partial().optional(),
  })
  .strict();
export type SettingsPatchT = z.infer<typeof SettingsPatch>;

export async function readSettings(): Promise<StoredSettingsT> {
  const { rows } = await query<{ settings: unknown }>(`SELECT settings FROM chat_settings WHERE id = 1`);
  const parsed = StoredSettings.safeParse(rows[0]?.settings ?? {});
  return parsed.success ? parsed.data : StoredSettings.parse({});
}

export async function writeSettings(patch: SettingsPatchT): Promise<StoredSettingsT> {
  const current = await readSettings();
  const { retrieval, ...rest } = patch;
  const next = StoredSettings.parse({ ...current, ...rest, retrieval: { ...current.retrieval, ...(retrieval ?? {}) } });
  await query(
    `INSERT INTO chat_settings (id, settings, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = now()`,
    [JSON.stringify(next)],
  );
  return next;
}
