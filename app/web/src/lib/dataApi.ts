import { request } from './http.js';

/** /api/data (docs/data.md#the-data-page). */

export interface DataQueryResult { columns: string[]; rows: unknown[][]; row_count: number; truncated: boolean; ms: number }

export interface DataOverview {
  dbBytes: number;
  dataBytes: number;
  dataTables: number;
  connectors: { total: number; ok: number; failing: number; never: number; broken: number };
  nextDue: string | null;
  dataDir: string;
}

export interface DataTable { schema: string; name: string; rows: number; rowsEstimated: boolean; bytes: number; owner: string | null }

export interface DataTableDetail {
  schema: string;
  name: string;
  columns: { name: string; type: string; nullable: boolean; key: boolean }[];
  latest: DataQueryResult | null;
}

export interface DataRun { id: number; status: string; startedAt: string; finishedAt: string | null; rows: Record<string, number>; args: string[]; error: string | null }

export interface DataConnector {
  name: string;
  description: string;
  command: string[];
  schedule: { every: string; at?: string } | null;
  enabled: boolean;
  tables: string[];
  env: string[];
  missingEnv: string[];
  nextDue: string | null;
  lastRuns: DataRun[];
  runCommand: string;
}

export interface DataJob { kind: 'timer' | 'connector'; name: string; owner: string; schedule: string; command: string; nextDue: string | null }

export interface DataPanel { title: string; chart: 'number' | 'line' | 'bar' | 'table'; sql: string; x?: string; y?: string[]; result?: DataQueryResult; error?: string }

export const dataApi = {
  overview: () => request<DataOverview>('/data/overview'),
  tables: () => request<{ tables: DataTable[] }>('/data/tables'),
  table: (schema: string, name: string) => request<DataTableDetail>(`/data/tables/${encodeURIComponent(schema)}/${encodeURIComponent(name)}`),
  connectors: () => request<{ connectors: DataConnector[]; errors: { name: string; error: string }[] }>('/data/connectors'),
  jobs: () => request<{ jobs: DataJob[] }>('/data/jobs'),
  dashboards: () => request<{ dashboards: { name: string; title: string; error?: string }[] }>('/data/dashboards'),
  dashboard: (name: string) => request<{ title: string; description?: string; panels: DataPanel[] }>(`/data/dashboards/${encodeURIComponent(name)}`),
};

export function bytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} kB`;
  return `${b} B`;
}
