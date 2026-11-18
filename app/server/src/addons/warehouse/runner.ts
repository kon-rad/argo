import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { query } from '../../db.js';
import { config } from '../../config.js';
import { redact } from '../../metrics/social/http.js';
import { loadToken } from '../../metrics/social/tokens.js';
import { isDue, loadConnectors, type ConnectorDef } from './connectors.js';

/**
 * Runs one connector (docs/warehouse.md#runner-contract). The script prints JSON lines on
 * stdout; this process validates each row against the connector's declared tables and
 * the table's real columns, and upserts them on the table's primary key in batches.
 * Connectors never hold a database connection, so they can't write anywhere else.
 */

export const SOURCE_KIND = 'warehouse-connector';
const BATCH = 500;
const STDERR_TAIL = 2048;
const LOG_KEEP = 50;

export interface RunOptions {
  args?: string[];
  /** Key for `social-token:` secrets; default SOCIAL_TOKEN_ENC_KEY. */
  encKey?: string;
  /** Root for raw files; the run gets `<rawRoot>/<connector>/<run id>/`. */
  rawRoot: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  connector: string;
  runId: number;
  status: 'ok' | 'failed';
  rows: Record<string, number>;
  error?: string;
}

export interface TableShape {
  columns: Map<string, string>; // name -> data_type
  pk: string[];
}

export async function tableShape(table: string): Promise<TableShape | null> {
  const cols = await query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'data' AND table_name = $1`,
    [table],
  );
  if (cols.rows.length === 0) return null;
  const pk = await query<{ attname: string }>(
    `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = format('data.%I', $1::text)::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`,
    [table],
  );
  return { columns: new Map(cols.rows.map((r) => [r.column_name, r.data_type])), pk: pk.rows.map((r) => r.attname) };
}

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

function toParam(v: unknown, type: string): unknown {
  if (v === null || v === undefined) return null;
  if (type === 'json' || type === 'jsonb') return JSON.stringify(v);
  if (typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(v);
  return v;
}

/** Upserts rows that share one column set. Later rows win over earlier ones with the same key. */
async function upsert(table: string, shape: TableShape, cols: string[], rows: Record<string, unknown>[]): Promise<void> {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const r of rows) byKey.set(JSON.stringify(shape.pk.map((k) => r[k])), r);
  const unique = [...byKey.values()];
  const params: unknown[] = [];
  const tuples = unique.map((r) => `(${cols.map((c) => { params.push(toParam(r[c], shape.columns.get(c)!)); return `$${params.length}`; }).join(',')})`);
  const updates = cols.filter((c) => !shape.pk.includes(c));
  const onConflict = updates.length
    ? `DO UPDATE SET ${updates.map((c) => `${qi(c)} = EXCLUDED.${qi(c)}`).join(', ')}`
    : 'DO NOTHING';
  await query(
    `INSERT INTO data.${qi(table)} (${cols.map(qi).join(',')}) VALUES ${tuples.join(',')}
     ON CONFLICT (${shape.pk.map(qi).join(',')}) ${onConflict}`,
    params,
  );
}

class Writer {
  private shapes = new Map<string, TableShape>();
  private buffers = new Map<string, { table: string; cols: string[]; rows: Record<string, unknown>[] }>();
  readonly counts: Record<string, number> = {};

  constructor(private readonly declared: Set<string>) {}

  async add(table: unknown, row: unknown): Promise<void> {
    if (typeof table !== 'string' || !this.declared.has(table)) throw new Error(`table "${String(table)}" is not in this connector's tables`);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`row for ${table} is not an object`);
    let shape = this.shapes.get(table);
    if (!shape) {
      const s = await tableShape(table);
      if (!s) throw new Error(`table data.${table} does not exist (run secondbrain warehouse migrate)`);
      if (s.pk.length === 0) throw new Error(`table data.${table} has no primary key; upserts need one`);
      this.shapes.set(table, s);
      shape = s;
    }
    const r = row as Record<string, unknown>;
    const cols = Object.keys(r).sort();
    for (const c of cols) if (!shape.columns.has(c)) throw new Error(`data.${table} has no column "${c}"`);
    for (const k of shape.pk) if (r[k] === undefined || r[k] === null) throw new Error(`row for data.${table} is missing key column "${k}"`);
    const key = `${table}\u0000${cols.join(',')}`;
    let buf = this.buffers.get(key);
    if (!buf) { buf = { table, cols, rows: [] }; this.buffers.set(key, buf); }
    buf.rows.push(r);
    this.counts[table] = (this.counts[table] ?? 0) + 1;
    if (buf.rows.length >= BATCH) await this.flushOne(key);
  }

  private async flushOne(key: string): Promise<void> {
    const buf = this.buffers.get(key);
    if (!buf || buf.rows.length === 0) return;
    const rows = buf.rows;
    buf.rows = [];
    await upsert(buf.table, this.shapes.get(buf.table)!, buf.cols, rows);
  }

  async flush(): Promise<void> {
    for (const key of this.buffers.keys()) await this.flushOne(key);
  }
}

async function sourceId(def: ConnectorDef): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO sources (kind, name, config) VALUES ($1, $2, $3)
     ON CONFLICT (kind, name) DO UPDATE SET config = EXCLUDED.config RETURNING id`,
    [SOURCE_KIND, def.name, JSON.stringify({ dir: def.dir, tables: def.tables })],
  );
  return rows[0]!.id;
}

export async function lastState(sourceIdValue: number): Promise<unknown> {
  const { rows } = await query<{ state: unknown }>(
    `SELECT stats->'state' AS state FROM ingest_runs WHERE source_id = $1 AND status = 'ok' ORDER BY started_at DESC LIMIT 1`,
    [sourceIdValue],
  );
  return rows[0]?.state ?? null;
}

/** Resolves `secrets` into env values. Throws naming the env key when a secret can't be read. */
export async function resolveSecrets(def: ConnectorDef, encKey: string | undefined): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [envName, ref] of Object.entries(def.secrets)) {
    const [, platform, account] = ref.split(':');
    let token;
    try {
      token = await loadToken(platform as 'instagram', account!, encKey);
    } catch (err) {
      throw new Error(`secret ${envName} (${ref}): ${(err as Error).message}`);
    }
    if (!token) throw new Error(`secret ${envName} (${ref}): no stored token for that account`);
    out[envName] = token.token;
  }
  return out;
}

export async function runConnector(def: ConnectorDef, opts: RunOptions): Promise<RunResult> {
  const src = await sourceId(def);
  const state = await lastState(src);
  const { rows } = await query<{ id: number }>(
    `INSERT INTO ingest_runs (source_id, status, stats) VALUES ($1, 'running', $2) RETURNING id`,
    [src, JSON.stringify({ args: opts.args ?? [] })],
  );
  const runId = rows[0]!.id;
  const rawDir = join(opts.rawRoot, def.name, String(runId));
  mkdirSync(rawDir, { recursive: true });

  const baseEnv = opts.env ?? process.env;
  let resolved: Record<string, string> = {};
  let secretError: string | null = null;
  try {
    resolved = await resolveSecrets(def, opts.encKey ?? config.socialTokenEncKey);
  } catch (err) {
    secretError = (err as Error).message;
  }
  const secrets = [...def.env.map((k) => baseEnv[k]), ...Object.values(resolved)];
  if (secretError) {
    const error = redact(secretError, secrets);
    await query(`UPDATE ingest_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [runId, error]);
    return { connector: def.name, runId, status: 'failed', rows: {}, error };
  }
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...resolved,
    DATA_CONNECTOR: def.name,
    DATA_RUN_ID: String(runId),
    DATA_RAW_DIR: rawDir,
    DATA_CONFIG: JSON.stringify(def.config),
    DATA_STATE: JSON.stringify(state ?? {}),
  };

  const writer = new Writer(new Set(def.tables));
  const logs: string[] = [];
  let newState: unknown = state ?? {};
  let failure: string | null = null;
  let timedOut = false;
  let stderr = '';

  const child = spawn(def.command[0]!, [...def.command.slice(1), ...(opts.args ?? [])], { cwd: def.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<{ code: number | null; error?: Error }>((res) => {
    child.on('error', (error) => res({ code: null, error }));
    child.on('close', (code) => res({ code }));
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => { stderr = (stderr + d).slice(-STDERR_TAIL); });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  }, def.timeoutSec * 1000);

  const progress = async () => {
    await query(`UPDATE ingest_runs SET progress = $2 WHERE id = $1`, [runId, JSON.stringify({ rows: writer.counts, logs: logs.slice(-5) })]).catch(() => {});
  };
  let lastProgress = Date.now();

  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (failure) continue; // drain so the child isn't blocked on a full pipe
      const text = line.trim();
      if (!text) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text);
      } catch {
        logs.push(text.slice(0, 500));
        continue;
      }
      try {
        if ('table' in msg) await writer.add(msg.table, msg.row);
        else if ('state' in msg) newState = msg.state;
        else if ('log' in msg) logs.push(String(msg.log).slice(0, 500));
        else logs.push(text.slice(0, 500));
      } catch (err) {
        failure = (err as Error).message;
        child.kill('SIGTERM');
      }
      if (Date.now() - lastProgress > 5000) { lastProgress = Date.now(); await progress(); }
    }
    const { code, error } = await exited;
    if (!failure) {
      if (error) failure = `could not start ${def.command[0]}: ${error.message}`;
      else if (timedOut) failure = `timed out after ${def.timeoutSec}s`;
      else if (code !== 0) failure = `exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`;
    }
    if (!failure) {
      try { await writer.flush(); } catch (err) { failure = (err as Error).message; }
    } else {
      // Rows already validated are still good data; keep them (every write is an idempotent upsert).
      await writer.flush().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
  }

  const error = failure ? redact(failure, secrets).slice(0, STDERR_TAIL) : null;
  const status = failure ? 'failed' : 'ok';
  await query(
    `UPDATE ingest_runs SET status = $2, finished_at = now(), stats = $3, progress = $4, error = $5 WHERE id = $1`,
    [
      runId,
      status,
      JSON.stringify({ rows: writer.counts, state: failure ? state ?? {} : newState, args: opts.args ?? [] }),
      JSON.stringify({ logs: logs.slice(-LOG_KEEP).map((l) => redact(l, secrets)) }),
      error,
    ],
  );
  return { connector: def.name, runId, status, rows: writer.counts, ...(error ? { error } : {}) };
}

export async function lastStarts(): Promise<Map<string, Date>> {
  const { rows } = await query<{ name: string; started: Date }>(
    `SELECT s.name, max(r.started_at) AS started FROM sources s JOIN ingest_runs r ON r.source_id = s.id
      WHERE s.kind = $1 GROUP BY s.name`,
    [SOURCE_KIND],
  );
  return new Map(rows.map((r) => [r.name, r.started]));
}

/** Runs every enabled connector whose schedule is due, one at a time. */
export async function runDue(dataDir: string, opts: RunOptions & { now?: Date }): Promise<RunResult[]> {
  const { defs } = loadConnectors(dataDir);
  const starts = await lastStarts();
  const now = opts.now ?? new Date();
  const results: RunResult[] = [];
  for (const def of defs) {
    if (!def.enabled || !isDue(def.schedule, starts.get(def.name) ?? null, now)) continue;
    results.push(await runConnector(def, opts));
  }
  return results;
}
