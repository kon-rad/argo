import { query, withTransaction } from '../db.js';
import { PATTERNS, redactor } from './redact.js';
import { stepFields } from './steps.js';

/**
 * One-off passes over rows stored before the agent-sessions migration: fill the step
 * columns, and redact keys in rows stored before redaction existed. Both are safe to
 * re-run; they only touch rows that still need it. Logs counts and variable names, never a value.
 */
type Log = (msg: string) => void;

export async function backfillSteps(opts: { batch: number; log: Log }): Promise<{ rows: number }> {
  let rows = 0;
  for (;;) {
    const { rows: batch } = await query<{ id: number; raw: unknown }>(
      `SELECT id, raw FROM archive_messages WHERE step IS NULL ORDER BY id LIMIT $1`, [opts.batch]);
    if (!batch.length) break;
    const f = batch.map((r) => stepFields(r.raw));
    await query(
      `UPDATE archive_messages m SET step = u.step, tool_names = u.tool_names, tool_call_id = u.tool_call_id, is_error = u.is_error
       FROM (SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::boolean[])
               AS t(id, step, tool_names_json, tool_call_id, is_error)) x
       CROSS JOIN LATERAL (SELECT x.step, x.tool_call_id, x.is_error,
         CASE WHEN x.tool_names_json IS NULL THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(x.tool_names_json::jsonb)) END AS tool_names) u
       WHERE m.id = x.id`,
      [batch.map((r) => r.id), f.map((x) => x.step), f.map((x) => (x.toolNames.length ? JSON.stringify(x.toolNames) : null)),
        f.map((x) => x.toolCallId), f.map((x) => x.isError)]);
    rows += batch.length;
    opts.log(`steps: ${rows} rows filled (last id ${batch[batch.length - 1]!.id})`);
  }
  return { rows };
}

const likeEscape = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Rewrites stored rows that hold a secret value this process knows or a key format.
 * Postgres finds the candidates (LIKE on the values, a POSIX regex on the formats), so
 * only matching rows cross the network; the JS redactor then does the exact replacement.
 */
export async function redactExisting(opts: { batch: number; dryRun: boolean; log: Log }): Promise<{ scanned: number; changed: number; sessions: number }> {
  const r = redactor();
  const likes = r.values.map((v) => likeEscape(v.value));
  const re = PATTERNS.map((p) => `(${p.pg})`).join('|');
  opts.log(`redact: ${r.values.length} env values (${r.values.map((v) => v.name).sort().join(', ') || 'none'}), ${PATTERNS.length} key formats${opts.dryRun ? ', dry run' : ''}`);
  const hit = (col: string) => `(${col} LIKE ANY ($1::text[]) OR ${col} ~ $2)`;

  const { rows: span } = await query<{ lo: string | null; hi: string | null }>(`SELECT min(id) lo, max(id) hi FROM archive_messages`);
  let scanned = 0;
  let changed = 0;
  if (span[0]?.lo != null) {
    const lo = Number(span[0].lo);
    const hi = Number(span[0].hi);
    const window = opts.batch * 10;
    for (let a = lo; a <= hi; a += window) {
      const { rows } = await query<{ id: number; content_text: string | null; raw: unknown }>(
        `SELECT id, content_text, raw FROM archive_messages
         WHERE id >= $3 AND id < $4 AND (${hit('coalesce(content_text, \'\')')} OR ${hit('raw::text')})`,
        [likes, re, a, a + window]);
      scanned += Math.min(window, hi - a + 1);
      const updates = rows.map((row) => {
        const text = row.content_text === null ? null : r.text(row.content_text);
        const raw = r.deep(row.raw);
        return { id: row.id, text, raw, same: text === row.content_text && JSON.stringify(raw) === JSON.stringify(row.raw) };
      }).filter((u) => !u.same);
      if (updates.length && !opts.dryRun) {
        await withTransaction(async (tx) => {
          for (const u of updates) await tx.query(`UPDATE archive_messages SET content_text = $2, raw = $3::jsonb WHERE id = $1`, [u.id, u.text, JSON.stringify(u.raw)]);
        });
      }
      changed += updates.length;
      if (rows.length) opts.log(`redact: ids ${a}..${a + window - 1}: ${rows.length} candidates, ${updates.length} rewritten`);
    }
  }

  const { rows: sess } = await query<{ id: number; title: string | null; meta: unknown }>(
    `SELECT id, title, meta FROM archive_sessions WHERE ${hit('coalesce(title, \'\')')} OR ${hit('meta::text')}`, [likes, re]);
  let sessions = 0;
  for (const s of sess) {
    const title = s.title === null ? null : r.text(s.title);
    const meta = r.deep(s.meta);
    if (title === s.title && JSON.stringify(meta) === JSON.stringify(s.meta)) continue;
    sessions++;
    if (!opts.dryRun) await query(`UPDATE archive_sessions SET title = $2, meta = $3::jsonb WHERE id = $1`, [s.id, title, JSON.stringify(meta)]);
  }
  opts.log(`redact: ${changed} messages and ${sessions} sessions ${opts.dryRun ? 'would be' : ''} rewritten`);
  return { scanned, changed, sessions };
}
