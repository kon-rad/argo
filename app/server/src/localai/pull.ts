import { query, withTransaction, type TxClient } from '../db.js';

/**
 * Copies a local model host's call log into the ledger. The host serves
 * GET <base>/api/export?table=<t>&after=<seq>&limit=<n> -> { rows, next_after, more },
 * rows in change order, and only seqs old enough that none can still appear below them,
 * so a cursor that advances to next_after never skips a row. Rows are upserted, so an
 * update on the host (a run that finishes, a model that is removed) arrives as a newer seq.
 */
export const LOCAL_AI_TABLES = ['models', 'model_loads', 'ai_texts', 'ai_runs', 'ai_run_texts'] as const;
export type LocalAiTable = (typeof LOCAL_AI_TABLES)[number];

type Row = Record<string, unknown>;
export interface ExportPage { rows: Row[]; next_after: number; more: boolean }
export type Fetcher = (url: string) => Promise<ExportPage>;

export interface PullResult { table: LocalAiTable; rows: number; after: number; error?: string }

const RUN_COLS = ['id', 'started_at', 'ended_at', 'state', 'service', 'route', 'http_status', 'model', 'model_digest', 'stream',
  'options', 'request_meta', 'tool_names', 'message_count', 'image_count', 'caller_label', 'caller_node', 'caller_process',
  'user_agent', 'prompt_tokens', 'cached_tokens', 'output_tokens', 'embed_count', 'ttft_ms', 'total_ms', 'load_ms',
  'prompt_eval_ms', 'eval_ms', 'prompt_tps', 'output_tps', 'done_reason', 'cold_start', 'input_chars', 'output_chars',
  'audio_seconds', 'voice', 'gpu_avg_w', 'package_avg_w', 'energy_j', 'error'] as const;

// table -> [target table, copied columns, key columns]. Caller IP, PID and command line stay on the host.
const SPEC: Record<LocalAiTable, [string, readonly string[], readonly string[]]> = {
  ai_runs: ['local_ai_runs', RUN_COLS, ['id']],
  ai_texts: ['local_ai_texts', ['sha256', 'content', 'chars', 'first_seen'], ['sha256']],
  ai_run_texts: ['local_ai_run_texts', ['run_id', 'seq', 'role', 'kind', 'text_sha256'], ['run_id', 'seq']],
  models: ['local_models', ['name', 'digest', 'family', 'param_size', 'quant', 'format', 'size_bytes', 'modified_at', 'first_seen', 'last_seen', 'removed_at'], ['name']],
  model_loads: ['local_model_loads', ['id', 'model', 'digest', 'loaded_at', 'unloaded_at', 'size_bytes', 'size_vram', 'context_length', 'runner', 'quant'], ['id']],
};
const JSON_COLS = new Set(['options', 'request_meta']);

function value(col: string, v: unknown): unknown {
  if (v === undefined) return null;
  if (JSON_COLS.has(col) && v !== null) return JSON.stringify(v);
  return v;
}

async function upsert(db: TxClient, host: string, table: LocalAiTable, rows: Row[]): Promise<void> {
  if (!rows.length) return;
  const [target, cols, keys] = SPEC[table];
  const all = ['host', ...cols, 'source_seq'];
  const params: unknown[] = [];
  const tuples = rows.map((r) => {
    const vals = [host, ...cols.map((c) => value(c, r[c])), r.change_seq];
    return `(${vals.map((v) => { params.push(v); return `$${params.length}`; }).join(', ')})`;
  });
  const updates = all.filter((c) => c !== 'host' && !keys.includes(c)).map((c) => `${c} = EXCLUDED.${c}`);
  if (target === 'local_ai_runs') updates.push('pulled_at = now()');
  await db.query(
    `INSERT INTO ${target} (${all.join(', ')}) VALUES ${tuples.join(', ')}
     ON CONFLICT (host, ${keys.join(', ')}) DO UPDATE SET ${updates.join(', ')}
     WHERE ${target}.source_seq < EXCLUDED.source_seq`, params);
}

export const httpFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url.replace(/\?.*/, '')}`);
  return (await res.json()) as ExportPage;
};

/** Pulls every table until the host says there is no more, or maxPages per table. */
export async function pullLocalAi(opts: { host: string; baseUrl: string; fetcher?: Fetcher; pageSize?: number; maxPages?: number }): Promise<PullResult[]> {
  const fetcher = opts.fetcher ?? httpFetcher;
  const pageSize = opts.pageSize ?? 500;
  const maxPages = opts.maxPages ?? 200;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const known = await query(`SELECT 1 FROM usage_hosts WHERE slug = $1`, [opts.host]);
  if (!known.rowCount) throw new Error(`host "${opts.host}" is not in usage_hosts; register it first`);
  const out: PullResult[] = [];
  for (const table of LOCAL_AI_TABLES) {
    await query(`INSERT INTO local_ai_cursors (host, tbl) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [opts.host, table]);
    const cur = await query<{ after_seq: number }>(`SELECT after_seq FROM local_ai_cursors WHERE host = $1 AND tbl = $2`, [opts.host, table]);
    let after = Number(cur.rows[0]!.after_seq);
    let rows = 0;
    try {
      for (let page = 0; page < maxPages; page++) {
        const p = await fetcher(`${base}/api/export?table=${table}&after=${after}&limit=${pageSize}`);
        // The rows and the cursor move together, so a crash mid-page repeats the page instead of skipping it.
        const next = Math.max(after, Number(p.next_after ?? after));
        await withTransaction(async (db) => {
          await upsert(db, opts.host, table, p.rows);
          await db.query(
            `UPDATE local_ai_cursors SET after_seq = $3, rows_total = rows_total + $4, last_ok_at = now(), last_try_at = now(), last_error = NULL
             WHERE host = $1 AND tbl = $2`, [opts.host, table, next, p.rows.length]);
        });
        after = next;
        rows += p.rows.length;
        if (!p.more || !p.rows.length) break;
      }
      out.push({ table, rows, after });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await query(`UPDATE local_ai_cursors SET last_error = $3, last_try_at = now() WHERE host = $1 AND tbl = $2`, [opts.host, table, msg.slice(0, 500)]);
      out.push({ table, rows, after, error: msg });
    }
  }
  return out;
}
