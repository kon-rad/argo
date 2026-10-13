import type pg from 'pg';
import { pool, query } from './db.js';
import { HttpError } from './routes/http.js';

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  generated: boolean;
  pk: boolean;
  references: { table: string; column: string } | null;
}

export interface TableInfo {
  name: string;
  kind: 'table' | 'view';
  /** Exact count for tables; null for views, which may be expensive to count. */
  rows: number | null;
  note: string | null;
  columns: ColumnInfo[];
}

/**
 * What each table holds, in one line. The catalog knows types, not meaning,
 * and the meaning is what both a reader and the SQL model need — especially
 * which tables are derived (rebuilt by a rescan) and which are the only copy.
 */
const NOTES: Record<string, string> = {
  sources: 'Configured ingest connectors (vault scanner, embeddings); config is jsonb.',
  ingest_runs: 'One row per connector run: status, timing, stats, error.',
  vault_files: 'Every file in the vault (derived; a rescan rebuilds it). body is the markdown text, frontmatter is jsonb, path is vault-relative.',
  vault_links: 'Wikilinks and markdown links between notes (derived). target_file_id is null when the link is unresolved.',
  vault_tags: 'Tags per note, from frontmatter and inline #tags (derived).',
  vault_chunks: 'Embedded chunks of markdown notes for semantic search (derived). embedding is a 1024-dim pgvector.',
  discord_guilds: 'Discord servers (phase 2 connector; empty until it runs).',
  discord_channels: 'Discord channels and threads.',
  discord_authors: 'Discord users seen in synced messages.',
  discord_messages: 'Discord messages, full-text indexed.',
  discord_message_versions: 'Earlier contents of edited Discord messages.',
  discord_attachments: 'Files attached to Discord messages.',
  discord_embeds: 'Link previews and rich embeds on Discord messages.',
  discord_reactions: 'Emoji reaction counts per Discord message.',
  search_documents: 'View: vault markdown and Discord messages unioned for keyword search.',
  inventory_items: 'Physical gear the owner keeps track of. Master copy, not derived: no rescan can rebuild it.',
  auth_sessions: 'Login sessions for the server deployment (only token hashes).',
  auth_totp_state: 'Last accepted TOTP step, to stop code replay.',
  hermes_sessions: 'Hermes agent / Friendly robot conversation sessions with token and cost totals.',
  hermes_turns: 'Individual turns of Hermes sessions: speaker, content, tool calls, tokens, cost.',
  pgmigrations: 'Applied schema migrations (node-pg-migrate bookkeeping).',
};

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export async function describeSchema(): Promise<TableInfo[]> {
  const { rows: cols } = await query<{
    tbl: string;
    relkind: string;
    col: string;
    type: string;
    nullable: boolean;
    def: string | null;
    generated: boolean;
  }>(
    `SELECT c.relname AS tbl, c.relkind::text AS relkind, a.attname AS col,
            format_type(a.atttypid, a.atttypmod) AS type,
            NOT a.attnotnull AS nullable,
            pg_get_expr(d.adbin, d.adrelid) AS def,
            a.attgenerated <> '' AS generated
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
     WHERE c.relkind IN ('r', 'p', 'v', 'm')
     ORDER BY c.relname, a.attnum`,
  );

  // Multi-column unnest pads the shorter array with nulls, so a primary key
  // (no confkey) and a foreign key come out of the same query.
  const { rows: cons } = await query<{
    tbl: string;
    contype: string;
    col: string;
    ref_table: string | null;
    ref_col: string | null;
  }>(
    `SELECT cl.relname AS tbl, con.contype::text AS contype, a.attname AS col,
            rc.relname AS ref_table, ra.attname AS ref_col
     FROM pg_constraint con
     JOIN pg_class cl ON cl.oid = con.conrelid
     CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(attnum, refnum)
     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
     LEFT JOIN pg_class rc ON rc.oid = con.confrelid
     LEFT JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refnum
     WHERE con.connamespace = 'public'::regnamespace AND con.contype IN ('p', 'f')`,
  );

  const tables = new Map<string, TableInfo>();
  for (const c of cols) {
    let t = tables.get(c.tbl);
    if (!t) {
      t = {
        name: c.tbl,
        kind: c.relkind === 'v' || c.relkind === 'm' ? 'view' : 'table',
        rows: null,
        note: NOTES[c.tbl] ?? null,
        columns: [],
      };
      tables.set(c.tbl, t);
    }
    t.columns.push({
      name: c.col,
      type: c.type,
      nullable: c.nullable,
      default: c.def,
      generated: c.generated,
      pk: false,
      references: null,
    });
  }
  for (const k of cons) {
    const col = tables.get(k.tbl)?.columns.find((c) => c.name === k.col);
    if (!col) continue;
    if (k.contype === 'p') col.pk = true;
    else if (k.ref_table && k.ref_col) col.references = { table: k.ref_table, column: k.ref_col };
  }

  // Exact counts, not pg_class.reltuples: the planner estimate reads 0 or -1
  // until autovacuum has analysed a table, which on this database it often
  // has not. Every table here is small enough to count in milliseconds.
  const counted = [...tables.values()].filter((t) => t.kind === 'table');
  if (counted.length > 0) {
    const { rows } = await query<{ tbl: string; n: number }>(
      counted
        .map((t, i) => `SELECT $${i + 1}::text AS tbl, count(*)::int AS n FROM ${quoteIdent(t.name)}`)
        .join(' UNION ALL '),
      counted.map((t) => t.name),
    );
    for (const r of rows) tables.get(r.tbl)!.rows = r.n;
  }

  return [...tables.values()];
}

/** The schema as compact text for the SQL model's prompt. */
export function schemaAsText(tables: readonly TableInfo[]): string {
  return tables
    .map((t) => {
      const head = `${t.kind} ${t.name}${t.rows != null ? ` (${t.rows} rows)` : ''}${t.note ? ` -- ${t.note}` : ''}`;
      const cols = t.columns.map((c) => {
        const bits = [c.type];
        if (c.pk) bits.push('PK');
        if (c.references) bits.push(`-> ${c.references.table}.${c.references.column}`);
        if (!c.nullable) bits.push('NOT NULL');
        return `  ${c.name} ${bits.join(' ')}`;
      });
      return [head, ...cols].join('\n');
    })
    .join('\n\n');
}

export const MAX_ROWS = 500;
const MAX_CELL_CHARS = 2000;
const TIMEOUT = '10s';

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  ms: number;
}

/** Leading comments and whitespace, so `-- note\nSELECT` still reads as a SELECT. */
const LEADING_NOISE = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
const READ_START = /^(select|with|table|values)\b/i;

/**
 * Runs one statement that can only read.
 *
 * Four layers, each enough on its own for the common case and together enough
 * for the odd one:
 *  - the statement must start as a query (SELECT / WITH / TABLE / VALUES);
 *  - it runs as a subquery, so it has to *be* a query to parse at all;
 *  - the extended protocol refuses a second statement, so `; COMMIT; DELETE`
 *    cannot step outside the transaction;
 *  - the transaction is READ ONLY and always rolled back, which also stops a
 *    data-modifying CTE (`WITH d AS (DELETE …) SELECT …`).
 * Row count and runtime are capped so a careless cross join cannot take the
 * server down with it.
 */
export async function runReadOnly(sqlText: string): Promise<QueryResult> {
  const sql = sqlText.trim().replace(/;\s*$/, '').trim();
  const body = sql.replace(LEADING_NOISE, '');
  if (!body) throw new HttpError(400, 'no SQL to run');
  if (!READ_START.test(body)) {
    throw new HttpError(400, 'only read queries can run here (SELECT, WITH, TABLE or VALUES)');
  }

  // The newline before the closing paren keeps a trailing `-- comment` from
  // swallowing it.
  const wrapped = `SELECT * FROM (\n${sql}\n) AS q LIMIT ${MAX_ROWS + 1}`;
  const client = await pool.connect();
  const started = performance.now();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${TIMEOUT}'`);
    // queryMode is supported by pg at runtime but missing from @types/pg.
    const run: pg.QueryArrayConfig & { queryMode: 'extended' } = {
      text: wrapped,
      rowMode: 'array',
      queryMode: 'extended',
    };
    const res = await client.query(run);
    const ms = Math.round(performance.now() - started);
    const truncated = res.rows.length > MAX_ROWS;
    const rows = (res.rows as unknown[][]).slice(0, MAX_ROWS).map((r) => r.map(cell));
    return { columns: res.fields.map((f) => f.name), rows, row_count: rows.length, truncated, ms };
  } catch (err) {
    // A Postgres error here is about the user's SQL, not the server: say what
    // it was, since that is the only way to fix the query.
    const e = err as { message?: string; code?: string };
    if (e.code) throw new HttpError(400, e.message ?? 'query failed', { code: e.code });
    throw err;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/** Keeps one 1024-float vector or a 60 KB note body from bloating the response. */
function cell(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return `<${v.length} bytes>`;
  if (typeof v === 'string' && v.length > MAX_CELL_CHARS) {
    return `${v.slice(0, MAX_CELL_CHARS)}… [${v.length - MAX_CELL_CHARS} more chars]`;
  }
  return v;
}
