/** Turns a question plus the schema text into one PostgreSQL query. */
export type SqlGenerator = (question: string, schema: string) => Promise<{ sql: string; model: string }>;

export function systemPrompt(schema: string, today = new Date().toISOString().slice(0, 10)): string {
  return `You write PostgreSQL 15 queries against the database of a personal knowledge vault (an Obsidian vault indexed into Postgres).

Rules:
- Answer with exactly one read-only query (SELECT or WITH ... SELECT). No INSERT, UPDATE, DELETE, DDL, or multiple statements.
- Output only the SQL. No explanation, no markdown fences.
- Add LIMIT 100 unless the question asks for an aggregate or a specific count.
- Never select vault_chunks.embedding or any tsv column; they are unreadable. Select their other columns instead.
- For "notes about X", prefer full-text search: tsv @@ websearch_to_tsquery('english', 'X'), ranked by ts_rank(tsv, ...).
- Markdown notes are vault_files rows WHERE is_markdown. Paths are vault-relative, e.g. 'Projects/secondbrain-app/spec.md'. Top-level folders are Projects/, Areas/, Research/, Archives/.
- frontmatter and config columns are jsonb: use ->> to read keys.
- Today is ${today}. Resolve relative dates against it.

Schema:
${schema}`;
}

/** Models wrap SQL in fences or reasoning tags however they are told; strip both. */
export function extractSql(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = /```(?:sql|postgresql)?\s*([\s\S]*?)```/i.exec(out);
  if (fence) out = fence[1]!.trim();
  return out;
}

export function togetherSqlGenerator(opts: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
}): SqlGenerator {
  const baseUrl = opts.baseUrl ?? 'https://api.together.xyz/v1';
  return async (question, schema) => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: systemPrompt(schema) },
          { role: 'user', content: question },
        ],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    // Status only: the upstream body is not worth the risk of echoing a
    // credential into an API response (see ProviderError in embeddings).
    if (!res.ok) throw new Error(`SQL model request failed with HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const sql = extractSql(data.choices?.[0]?.message?.content ?? '');
    if (!sql) throw new Error('the SQL model returned an empty answer');
    return { sql, model: opts.model };
  };
}
