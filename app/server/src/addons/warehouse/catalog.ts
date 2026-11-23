import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { config } from '../../config.js';
import { query } from '../../db.js';
import { runReadOnly, type QueryResult } from '../../dbExplorer.js';
import { enabledManifests } from '../../features/registry.js';
import { settings, type WarehouseSettings } from '../../settings.js';
import { loadConnectors, nextScheduledAt, type ConnectorDef, type ConnectorError } from './connectors.js';
import { SOURCE_KIND } from './runner.js';

/** What the /warehouse page and `secondbrain warehouse status|tables` read (docs/warehouse.md#the-warehouse-page). */

export function dataPaths(vaultRoot = config.vaultRoot, s: WarehouseSettings = settings(vaultRoot).warehouse) {
  const dir = isAbsolute(s.dir) ? s.dir : resolve(vaultRoot, s.dir);
  const rawRoot = s.rawDir ? (isAbsolute(s.rawDir) ? s.rawDir : resolve(vaultRoot, s.rawDir)) : join(config.dataDir, 'warehouse-raw');
  return { dir, rawRoot, migrations: join(dir, 'migrations'), dashboards: join(dir, 'dashboards') };
}

export interface TableRow {
  schema: string;
  name: string;
  rows: number;
  rowsEstimated: boolean;
  bytes: number;
  owner: string | null;
}

/** Below this estimate a table is counted exactly; above it the planner's estimate is shown. */
const EXACT_BELOW = 200_000;

export async function listTables(defs: ConnectorDef[], modules: ReadonlySet<string>): Promise<TableRow[]> {
  const { rows } = await query<{ schema: string; name: string; est: string; bytes: string }>(
    `SELECT n.nspname AS schema, c.relname AS name, c.reltuples::bigint AS est, pg_total_relation_size(c.oid) AS bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp%'
      ORDER BY n.nspname = 'data' DESC, n.nspname, c.relname`,
  );
  const owners = new Map<string, string>();
  for (const m of enabledManifests(modules)) for (const t of m.health?.tables ?? []) owners.set(t.includes('.') ? t : `public.${t}`, m.name);
  for (const d of defs) for (const t of d.tables) owners.set(`data.${t}`, `connector:${d.name}`);
  const out: TableRow[] = [];
  for (const r of rows) {
    const est = Number(r.est);
    let count = est;
    let estimated = true;
    if (est < EXACT_BELOW) {
      const q = await query<{ n: string }>(`SELECT count(*) AS n FROM ${ident(r.schema)}.${ident(r.name)}`);
      count = Number(q.rows[0]!.n);
      estimated = false;
    }
    out.push({ schema: r.schema, name: r.name, rows: count, rowsEstimated: estimated, bytes: Number(r.bytes), owner: owners.get(`${r.schema}.${r.name}`) ?? null });
  }
  return out;
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

export interface TableDetail {
  schema: string;
  name: string;
  columns: { name: string; type: string; nullable: boolean; key: boolean }[];
  /** Up to 20 rows, only for tables in schema data. */
  latest: QueryResult | null;
}

export async function tableDetail(schema: string, name: string): Promise<TableDetail | null> {
  const cols = await query<{ column_name: string; data_type: string; is_nullable: string }>(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
    [schema, name],
  );
  if (cols.rows.length === 0) return null;
  const pk = await query<{ attname: string }>(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = format('%I.%I', $1::text, $2::text)::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`,
    [schema, name],
  );
  const keys = pk.rows.map((r) => r.attname);
  let latest: QueryResult | null = null;
  if (schema === 'data') {
    const order = keys.length ? ` ORDER BY ${keys.map((k) => `${ident(k)} DESC`).join(', ')}` : '';
    latest = await runReadOnly(`SELECT * FROM data.${ident(name)}${order} LIMIT 20`);
  }
  return {
    schema,
    name,
    columns: cols.rows.map((c) => ({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES', key: keys.includes(c.column_name) })),
    latest,
  };
}

export interface RunRow {
  id: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  rows: Record<string, number>;
  args: string[];
  error: string | null;
}

export interface ConnectorView {
  name: string;
  description: string;
  command: string[];
  schedule: { every: string; at?: string } | null;
  enabled: boolean;
  tables: string[];
  env: string[];
  missingEnv: string[];
  nextDue: string | null;
  lastRuns: RunRow[];
  runCommand: string;
}

export async function connectorViews(defs: ConnectorDef[], now = new Date()): Promise<ConnectorView[]> {
  const { rows } = await query<{ name: string; id: number; status: string; started_at: Date; finished_at: Date | null; stats: { rows?: Record<string, number>; args?: string[] }; error: string | null }>(
    `SELECT s.name, r.id, r.status, r.started_at, r.finished_at, r.stats, r.error
       FROM sources s
       JOIN LATERAL (SELECT * FROM ingest_runs WHERE source_id = s.id ORDER BY started_at DESC LIMIT 10) r ON true
      WHERE s.kind = $1
      ORDER BY s.name, r.started_at DESC`,
    [SOURCE_KIND],
  );
  const runs = new Map<string, RunRow[]>();
  for (const r of rows) {
    const list = runs.get(r.name) ?? [];
    list.push({ id: r.id, status: r.status, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null, rows: r.stats?.rows ?? {}, args: r.stats?.args ?? [], error: r.error });
    runs.set(r.name, list);
  }
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    command: d.command,
    schedule: d.schedule ?? null,
    enabled: d.enabled,
    tables: d.tables,
    env: d.env,
    missingEnv: d.env.filter((k) => !process.env[k]),
    nextDue: d.schedule && d.enabled ? nextScheduledAt(d.schedule, now).toISOString() : null,
    lastRuns: runs.get(d.name) ?? [],
    runCommand: `secondbrain warehouse run ${d.name}`,
  }));
}

export interface JobRow {
  kind: 'timer' | 'connector';
  name: string;
  owner: string;
  schedule: string;
  command: string;
  nextDue: string | null;
}

export function listJobs(defs: ConnectorDef[], modules: ReadonlySet<string>, now = new Date()): JobRow[] {
  const timers: JobRow[] = enabledManifests(modules).flatMap((m) =>
    m.timers.map((t) => ({ kind: 'timer' as const, name: t.unit, owner: m.name, schedule: t.calendar, command: `secondbrain ${t.command}`, nextDue: null })),
  );
  const conns: JobRow[] = defs
    .filter((d) => d.schedule && d.enabled)
    .map((d) => ({
      kind: 'connector' as const,
      name: d.name,
      owner: 'warehouse',
      schedule: `every ${d.schedule!.every}${d.schedule!.at ? ` at ${d.schedule!.at} UTC` : ''}`,
      command: `secondbrain warehouse run ${d.name}`,
      nextDue: nextScheduledAt(d.schedule!, now).toISOString(),
    }));
  return [...conns, ...timers];
}

export async function overview(defs: ConnectorDef[], errors: ConnectorError[], now = new Date()) {
  const size = await query<{ db: string; data: string; tables: string }>(
    `SELECT pg_database_size(current_database()) AS db,
            coalesce(sum(pg_total_relation_size(c.oid)) FILTER (WHERE n.nspname = 'data'), 0) AS data,
            count(*) FILTER (WHERE n.nspname = 'data') AS tables
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p')`,
  );
  const views = await connectorViews(defs, now);
  const last = (v: ConnectorView) => v.lastRuns.find((r) => r.status !== 'running');
  const nextDue = views.map((v) => v.nextDue).filter((x): x is string => Boolean(x)).sort()[0] ?? null;
  return {
    dbBytes: Number(size.rows[0]!.db),
    dataBytes: Number(size.rows[0]!.data),
    dataTables: Number(size.rows[0]!.tables),
    connectors: {
      total: views.length,
      ok: views.filter((v) => last(v)?.status === 'ok').length,
      failing: views.filter((v) => last(v)?.status === 'failed').length,
      never: views.filter((v) => !last(v)).length,
      broken: errors.length,
    },
    nextDue,
  };
}

const Panel = z.object({
  title: z.string(),
  chart: z.enum(['number', 'line', 'bar', 'table']),
  sql: z.string().min(1),
  x: z.string().optional(),
  y: z.array(z.string()).optional(),
});
const Dashboard = z.object({ title: z.string(), description: z.string().optional(), area: z.string().min(1).optional(), panels: z.array(Panel) });
export type DashboardPanel = z.infer<typeof Panel> & { result?: QueryResult; error?: string };

export function listDashboards(dir: string): { name: string; title: string; area?: string; error?: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const name = f.slice(0, -5);
      try {
        const spec = Dashboard.parse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
        return { name, title: spec.title, ...(spec.area ? { area: spec.area } : {}) };
      } catch (err) {
        return { name, title: name, error: (err as Error).message.slice(0, 300) };
      }
    });
}

export async function renderDashboard(dir: string, name: string): Promise<{ title: string; description?: string; panels: DashboardPanel[] } | null> {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return null;
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return null;
  const spec = Dashboard.parse(JSON.parse(readFileSync(file, 'utf8')));
  const panels: DashboardPanel[] = [];
  for (const p of spec.panels) {
    try {
      panels.push({ ...p, result: await runReadOnly(p.sql) });
    } catch (err) {
      panels.push({ ...p, error: (err as Error).message });
    }
  }
  return { title: spec.title, description: spec.description, panels };
}

export function connectorsFor(vaultRoot = config.vaultRoot) {
  return loadConnectors(dataPaths(vaultRoot).dir);
}
