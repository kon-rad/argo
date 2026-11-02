import { query, withTransaction } from '../db.js';
import { hermesChannel, isLocalCommandText, parseChannelTag, stripChannelTag, zenChannel } from './channel.js';
import { channelMeta } from './channelMeta.js';
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
export async function redactExisting(opts: { batch: number; dryRun: boolean; log: Log; sinceId?: number }):
  Promise<{ scanned: number; changed: number; sessions: number; lastId: number }> {
  const r = redactor();
  const likes = r.values.map((v) => likeEscape(v.value));
  const re = PATTERNS.map((p) => `(${p.pg})`).join('|');
  opts.log(`redact: ${r.values.length} env values (${r.values.map((v) => v.name).sort().join(', ') || 'none'}), ${PATTERNS.length} key formats${opts.dryRun ? ', dry run' : ''}`);
  const hit = (col: string) => `(${col} LIKE ANY ($1::text[]) OR ${col} ~ $2)`;

  const { rows: span } = await query<{ lo: string | null; hi: string | null }>(
    `SELECT min(id) lo, max(id) hi FROM archive_messages WHERE id > $1`, [opts.sinceId ?? 0]);
  let scanned = 0;
  let changed = 0;
  let lastId = opts.sinceId ?? 0;
  if (span[0]?.lo != null) {
    lastId = Number(span[0].hi);
    const lo = Number(span[0].lo);
    const hi = Number(span[0].hi);
    const window = opts.batch * 10;
    for (let a = lo; a <= hi; a += window) {
      // raw as text and back with ::jsonb: a JS parse would round integers above 2^53.
      const { rows } = await query<{ id: number; content_text: string | null; raw_text: string }>(
        `SELECT id, content_text, raw::text AS raw_text FROM archive_messages
         WHERE id >= $3 AND id < $4 AND (${hit('coalesce(content_text, \'\')')} OR ${hit('raw::text')})`,
        [likes, re, a, a + window]);
      scanned += Math.min(window, hi - a + 1);
      const updates = rows.map((row) => {
        const text = row.content_text === null ? null : r.text(row.content_text);
        const raw = r.jsonText(row.raw_text);
        return { id: row.id, text, raw, same: text === row.content_text && raw === row.raw_text };
      }).filter((u) => !u.same);
      if (updates.length && !opts.dryRun) {
        await withTransaction(async (tx) => {
          for (const u of updates) await tx.query(`UPDATE archive_messages SET content_text = $2, raw = $3::jsonb WHERE id = $1`, [u.id, u.text, u.raw]);
        });
      }
      changed += updates.length;
      if (rows.length) opts.log(`redact: ids ${a}..${a + window - 1}: ${rows.length} candidates, ${updates.length} rewritten`);
    }
  }

  const { rows: sess } = await query<{ id: number; title: string | null; meta_text: string }>(
    `SELECT id, title, meta::text AS meta_text FROM archive_sessions WHERE ${hit('coalesce(title, \'\')')} OR ${hit('meta::text')}`, [likes, re]);
  let sessions = 0;
  for (const s of sess) {
    const title = s.title === null ? null : r.text(s.title);
    const meta = r.jsonText(s.meta_text);
    if (title === s.title && meta === s.meta_text) continue;
    sessions++;
    if (!opts.dryRun) await query(`UPDATE archive_sessions SET title = $2, meta = $3::jsonb WHERE id = $1`, [s.id, title, meta]);
  }
  opts.log(`redact: ${changed} messages and ${sessions} sessions ${opts.dryRun ? 'would be ' : ''}rewritten`);
  return { scanned, changed, sessions, lastId };
}

/**
 * Labels sessions stored before the channel column existed (channel.ts): Claude Code sessions whose
 * prompts carry a `<channel …>` tag get `meta.channel` and the tag stripped from `content_text`, slash
 * command records become `meta` steps, Hermes sessions take it from their `source`, zen-agent runs
 * from their dispatch labels. Safe to re-run: a labelled session is skipped.
 */
export async function relabelChannels(opts: { batch: number; log: Log }): Promise<{ sessions: number; messages: number; commands: number }> {
  const out = { sessions: 0, messages: 0, commands: 0 };
  // Claude Code: the tag is at the start of a prompt's text.
  for (;;) {
    const { rows } = await query<{ id: number; source: string; meta: Record<string, unknown> }>(
      `SELECT s.id, s.source, s.meta FROM archive_sessions s WHERE s.source = 'claude-code' AND NOT (s.meta ? 'channel')
         AND EXISTS (SELECT 1 FROM archive_messages m WHERE m.session_id = s.id AND m.content_text LIKE '<channel %')
       ORDER BY s.id LIMIT $1`, [opts.batch]);
    if (!rows.length) break;
    for (const s of rows) {
      const { rows: msgs } = await query<{ id: number; content_text: string }>(
        `SELECT id, content_text FROM archive_messages WHERE session_id = $1 AND content_text LIKE '<channel %' ORDER BY seq`, [s.id]);
      const tag = msgs.map((m) => parseChannelTag(m.content_text)).find((t) => t) ?? null;
      await withTransaction(async (tx) => {
        for (const m of msgs) {
          await tx.query(`UPDATE archive_messages SET content_text = $2 WHERE id = $1`, [m.id, stripChannelTag(m.content_text)]);
          out.messages++;
        }
        // `|| '{}'` keeps the row from being picked again when the tag names a channel this version doesn't know.
        await tx.query(`UPDATE archive_sessions SET meta = meta || $2::jsonb, updated_at = now() WHERE id = $1`,
          [s.id, JSON.stringify({ channel: null, ...channelMeta(tag, 'claude-code') })]);
      });
      out.sessions++;
    }
    opts.log(`relabel: ${out.sessions} Claude Code sessions (last id ${rows[rows.length - 1]!.id})`);
  }
  // Slash commands typed at the keyboard were stored as prompts; they are session records.
  for (;;) {
    const { rows } = await query<{ id: number; content_text: string }>(
      `SELECT m.id, m.content_text FROM archive_messages m JOIN archive_sessions s ON s.id = m.session_id
       WHERE s.source = 'claude-code' AND m.step = 'prompt' AND (m.content_text LIKE '<command-name>%' OR m.content_text LIKE '<local-command-%')
       ORDER BY m.id LIMIT $1`, [opts.batch]);
    const ids = rows.filter((r) => isLocalCommandText(r.content_text)).map((r) => r.id);
    if (!ids.length) break;
    await query(`UPDATE archive_messages SET step = 'meta' WHERE id = ANY ($1::bigint[])`, [ids]);
    out.commands += ids.length;
    if (ids.length < rows.length) break;
  }
  // Hermes: the gateway's source column came along in meta.
  const { rows: hermes } = await query<{ id: number; source: string; src: string; profile: string | null }>(
    `SELECT id, source, meta ->> 'source' AS src, meta ->> 'profile' AS profile FROM archive_sessions
     WHERE harness = 'hermes' AND meta ->> 'channel' IS NULL AND meta ->> 'source' IN ('telegram', 'api_server')`);
  for (const h of hermes) {
    await query(`UPDATE archive_sessions SET meta = meta || $2::jsonb, updated_at = now() WHERE id = $1`,
      [h.id, JSON.stringify(channelMeta(hermesChannel(h.src), 'hermes', h.profile))]);
    out.sessions++;
  }
  // zen-agent: the bridge's labels are in meta.dispatch.
  const { rows: zen } = await query<{ id: number; dispatch: Record<string, unknown> | null }>(
    `SELECT id, meta -> 'dispatch' AS dispatch FROM archive_sessions
     WHERE source = 'zen-agent' AND meta ->> 'channel' IS NULL AND (meta -> 'dispatch' ->> 'channel' IS NOT NULL OR meta -> 'dispatch' ->> 'reasons' LIKE '%telegram%')`);
  for (const z of zen) {
    const d = z.dispatch ?? {};
    let reasons: Array<{ reason: string | null }> = [];
    try { reasons = typeof d.reasons === 'string' ? JSON.parse(d.reasons) : Array.isArray(d.reasons) ? d.reasons as never : []; } catch { reasons = []; }
    const ch = zenChannel(d, reasons);
    if (!ch) continue;
    await query(`UPDATE archive_sessions SET meta = meta || $2::jsonb, updated_at = now() WHERE id = $1`,
      [z.id, JSON.stringify(channelMeta(ch, 'zen-agent', typeof d.bot === 'string' ? d.bot : null))]);
    out.sessions++;
  }
  opts.log(`relabel: ${out.sessions} sessions labelled, ${out.messages} prompts unwrapped, ${out.commands} command records reclassified`);
  return out;
}
