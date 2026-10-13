export interface TreeDir {
  name: string;
  path: string;
  child_count: number;
}

export interface TreeFile {
  id: number;
  name: string;
  path: string;
  ext: string;
  is_markdown: boolean;
  size_bytes: number;
  mtime: string;
  title: string | null;
}

export interface TreeResponse {
  path: string;
  dirs: TreeDir[];
  files: TreeFile[];
  total: number;
  has_more: boolean;
}

export interface FileMeta extends TreeFile {
  parent_path: string;
  body: string | null;
}

export interface OutLink {
  target_raw: string;
  alias: string | null;
  file_id: number | null;
  path: string | null;
  title: string | null;
}

export interface Backlink {
  id: number;
  path: string;
  title: string | null;
}

export interface FileResponse {
  file: FileMeta;
  frontmatter: Record<string, unknown>;
  tags: string[];
  links: OutLink[];
  backlinks: Backlink[];
}

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

export interface SearchHit {
  source_kind: string;
  ref_id: string;
  ref_path: string;
  title: string | null;
  snippet: string;
  rank: number;
  occurred_at: string;
  /** Present in semantic and hybrid modes only. */
  match_kind?: 'text' | 'filename' | 'semantic' | 'hybrid';
  similarity?: number | null;
  heading_path?: string | null;
}

export interface SearchResponse {
  q: string;
  mode: SearchMode;
  results: SearchHit[];
  total: number;
  has_more: boolean;
  /** Hybrid only: the vector branch was unreachable and this is keyword-only. */
  degraded?: boolean;
}

export interface Run {
  id: number;
  source_id: number;
  status: 'queued' | 'running' | 'ok' | 'error';
  started_at: string;
  finished_at: string | null;
  stats: Record<string, unknown>;
  progress: Record<string, unknown>;
  error: string | null;
}

export interface Source {
  id: number;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  last_run: Run | null;
  running: boolean;
}

export interface EmbeddingInfo {
  chunks: number;
  files_embedded: number;
  files_embeddable: number;
  model: string | null;
  last_embedded_at: string | null;
}

export interface SystemInfo {
  vault_root: string;
  counts: { files: number; markdown: number; links: number; tags: number };
  embeddings: EmbeddingInfo;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RingDay {
  day: string;
  sleep_score: number | null;
  total_sleep_min: number | null;
  time_in_bed_min: number | null;
  deep_min: number | null;
  rem_min: number | null;
  light_min: number | null;
  awake_min: number | null;
  sleep_efficiency_pct: number | null;
  restorative_pct: number | null;
  temp_deviation_c: number | null;
  spo2_pct: number | null;
  bedtime_start: number | null;
  bedtime_end: number | null;
  steps_total: number | null;
  hrv_avg: number | null;
  sleep_hrv: number | null;
  sleep_rhr: number | null;
  recovery_index: number | null;
  movement_index: number | null;
  active_min: number | null;
  vo2_max: number | null;
}

export interface RingOverview {
  days: RingDay[];
  total_days: number;
  last_received: string | null;
  can_pull: boolean;
}

export interface RingNight {
  day: RingDay;
  stages: { start: number; end: number; stage: string }[];
  heart_rate: { ts: number; value: number }[];
  hrv: { ts: number; value: number }[];
}

/** What this install has turned on (server: GET /api/meta). */
export interface AppMeta {
  modules: ('ring' | 'agents')[];
  owner: string;
  devLogPath: string | null;
  docsPath: string | null;
  robot: boolean;
}

export interface AgentSession {
  id: number;
  source: string;
  host: string;
  external_id: string;
  parent_external_id: string | null;
  title: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  message_count: number;
  profile: string;
  platform: string | null;
  display_name: string | null;
  chat_type: string | null;
  chat_id: string | null;
  user_id: string | null;
  timezone: string | null;
}

export interface AgentMessage {
  seq: number;
  role: string;
  ts: string | null;
  content: string | null;
  reasoning: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  finish_reason: string | null;
}

export interface SyncInfo {
  ran_at: string;
  host: string;
}

export interface CronJob {
  profile: string;
  job_id: string;
  name: string;
  schedule: string | null;
  state: string | null;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  deliver: string | null;
  skill: string | null;
  script?: string | null;
  prompt?: string | null;
  timezone: string | null;
  removed_at: string | null;
  runs?: number;
  outputs?: number;
}

export interface CronJobDetail {
  job: CronJob;
  runs: { id: string; status: string; claimed_at: string | null; started_at: string | null; finished_at: string | null; error: string | null }[];
  outputs: { file_name: string; run_at: string | null; chars: number; preview: string }[];
  sessions: { id: number; external_id: string; started_at: string | null; message_count: number }[];
}

export interface SystemdTimer {
  unit: string;
  activates: string;
  next: string | null;
  last: string | null;
}

/** agent-hub (droplet only): Telegram + default agent. */
export interface TelegramStatus {
  default: 'claude' | 'hermes';
  claude_running: boolean;
  hermes_running: boolean;
  claude_bot_configured: boolean;
  bots_distinct: boolean;
}

export interface HubAgent {
  name: string;
  family: 'claude' | 'hermes';
  description?: string;
  model?: string;
}

export interface KanbanTask {
  id: string;
  title: string;
  body: string | null;
  assignee: string | null;
  status: string;
  priority: number;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
}

export interface KanbanTaskDetail {
  task: KanbanTask;
  latest_summary: string | null;
  parents: string[];
  children: string[];
  comments: { author: string; body: string; created_at: number }[];
  events: { kind: string; payload: Record<string, unknown> | null; created_at: number }[];
}

/** One line of a Claude Code stream-json log (or a line agent-hub added: "you", "hub"). */
export type StreamEvent = Record<string, unknown> & { type: string };

export interface EventPage {
  events: StreamEvent[];
  offset: number;
  size: number;
}

export interface ClaudeChat {
  id: string;
  title: string;
  cwd: string;
  model: string;
  created_at: number;
  updated_at: number;
  session_id: string;
  status: 'idle' | 'working' | 'closed' | 'error';
  last_result: string;
  live: boolean;
}

type Params = Record<string, string | number | boolean | undefined>;

function url(path: string, params?: Params): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return `/api${path}${qs ? `?${qs}` : ''}`;
}

/** Fired when any call answers 401, so the shell can swap to the login screen. */
export const AUTH_EXPIRED_EVENT = 'secondbrain:auth-expired';

async function request<T>(path: string, params?: Params, init?: RequestInit): Promise<T> {
  const res = await fetch(url(path, params), { credentials: 'same-origin', ...init });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
  if (!res.ok) {
    // The server always answers with { error: { message } }; a proxy in front
    // of it might not, so fall back to the status line rather than throwing
    // inside the error path.
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiError(res.status, body?.error?.message ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export interface AuthState {
  /** False on the Mac, where localhost is the boundary and there is no login. */
  required: boolean;
  authenticated: boolean;
}

export interface FileSource {
  path: string;
  content: string;
  /** sha256 of the bytes on disk — sent back on save as the conflict check. */
  hash: string;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export interface FriendlyStatus {
  status: 'running' | 'starting' | 'stopped';
  port: number;
}

export interface DbColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  generated: boolean;
  pk: boolean;
  references: { table: string; column: string } | null;
}

export interface DbTable {
  name: string;
  kind: 'table' | 'view';
  rows: number | null;
  note: string | null;
  columns: DbColumn[];
}

export interface DbQueryResult {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  ms: number;
}

export const api = {
  tree: (path: string, offset = 0, limit = 200) =>
    request<TreeResponse>('/tree', { path, offset, limit }),
  file: (path: string) => request<FileResponse>('/file', { path }),
  search: (q: string, source?: string, offset = 0, limit = 25, mode: SearchMode = 'keyword') =>
    request<SearchResponse>('/search', { q, source, offset, limit, mode }),
  sources: () => request<{ sources: Source[] }>('/sources'),
  runs: (params: { active?: boolean; source_id?: number; limit?: number } = {}) =>
    request<{ runs: Run[] }>('/runs', {
      active: params.active ? '1' : undefined,
      source_id: params.source_id,
      limit: params.limit,
    }),
  sync: (id: number) =>
    request<{ run_id: number; status: string }>(`/sources/${id}/sync`, undefined, {
      method: 'POST',
    }),
  system: () => request<SystemInfo>('/system'),
  friendlyStatus: () => request<FriendlyStatus>('/friendly/status'),
  friendlyStart: () =>
    request<FriendlyStatus>('/friendly/start', undefined, { method: 'POST' }),
  shutdown: () => request<{ status: string }>('/shutdown', undefined, { method: 'POST' }),
  me: () => request<AuthState>('/auth/me'),
  login: (password: string, code: string) =>
    request<{ authenticated: boolean }>('/auth/login', undefined, json('POST', { password, code })),
  logout: () => request<{ authenticated: boolean }>('/auth/logout', undefined, { method: 'POST' }),
  logoutAll: () =>
    request<{ authenticated: boolean; ended: number }>('/auth/logout-all', undefined, { method: 'POST' }),
  dbSchema: () => request<{ tables: DbTable[] }>('/db/schema'),
  dbAsk: (question: string) =>
    request<{ sql: string; model: string }>('/db/ask', undefined, json('POST', { question })),
  dbQuery: (sql: string) => request<DbQueryResult>('/db/query', undefined, json('POST', { sql })),
  ring: () => request<RingOverview>('/ring'),
  ringNight: (day: string) => request<RingNight>(`/ring/night/${day}`),
  ringPull: () =>
    request<{ counts: Record<string, number> }>('/ring/pull', undefined, { method: 'POST' }),
  agentChats: (params: { platform?: string; profile?: string } = {}) =>
    request<{ sessions: AgentSession[]; facets: { platform: string | null; profile: string; n: number }[]; last_sync: SyncInfo | null }>(
      '/agents/chats',
      params,
    ),
  agentChat: (id: number) => request<{ session: AgentSession; messages: AgentMessage[] }>(`/agents/chats/${id}`),
  cronJobs: () => request<{ jobs: CronJob[]; last_sync: SyncInfo | null }>('/agents/cron/jobs'),
  cronJob: (profile: string, jobId: string) =>
    request<CronJobDetail>(`/agents/cron/jobs/${encodeURIComponent(profile)}/${encodeURIComponent(jobId)}`),
  cronOutput: (profile: string, jobId: string, file: string) =>
    request<{ file_name: string; run_at: string | null; content: string }>(
      `/agents/cron/jobs/${encodeURIComponent(profile)}/${encodeURIComponent(jobId)}/outputs/${encodeURIComponent(file)}`,
    ),
  cronTimers: () => request<{ available: boolean; timers: SystemdTimer[] }>('/agents/cron/timers'),
  telegram: () => request<TelegramStatus>('/hub/telegram'),
  setTelegram: (change: { default: 'claude' | 'hermes' } | { claude: 'on' | 'off' }) =>
    request<TelegramStatus>('/hub/telegram', undefined, json('POST', change)),
  hubAgents: () => request<{ lanes: HubAgent[]; profiles: HubAgent[] }>('/hub/agents'),
  boards: () => request<{ boards: { slug: string; name: string }[] }>('/hub/boards'),
  board: (board: string) => request<{ board: string; tasks: KanbanTask[] }>('/hub/board', { board }),
  task: (id: string, board: string) => request<KanbanTaskDetail>(`/hub/tasks/${id}`, { board }),
  taskLog: (id: string, offset: number) => request<EventPage>(`/hub/tasks/${id}/log`, { offset }),
  createTask: (t: { board: string; title: string; body: string; assignee: string }) =>
    request<KanbanTask>('/hub/tasks', undefined, json('POST', t)),
  commentTask: (id: string, board: string, text: string) =>
    request<{ ok: true }>(`/hub/tasks/${id}/comment`, undefined, json('POST', { board, text })),
  claudeChats: () => request<{ chats: ClaudeChat[] }>('/hub/chats'),
  newClaudeChat: (model?: string) => request<ClaudeChat>('/hub/chats', undefined, json('POST', model ? { model } : {})),
  claudeChatEvents: (id: string, offset: number) =>
    request<EventPage & { chat: ClaudeChat }>(`/hub/chats/${id}/events`, { offset }),
  sendClaudeChat: (id: string, text: string) =>
    request<ClaudeChat>(`/hub/chats/${id}/messages`, undefined, json('POST', { text })),
  stopClaudeChat: (id: string) => request<{ ok: true }>(`/hub/chats/${id}/interrupt`, undefined, { method: 'POST' }),
  meta: () => request<AppMeta>('/meta'),
  source: (path: string) => request<FileSource>('/file/source', { path }),
  save: (path: string, content: string, baseHash: string) =>
    request<{ path: string; hash: string; mtime: string; size_bytes: number }>(
      '/file/source',
      undefined,
      json('PUT', { path, content, base_hash: baseHash }),
    ),
};

export const rawUrl = (path: string): string => url('/raw', { path });
export const downloadUrl = (path: string): string => url('/raw', { path, download: 1 });
/** The file a `.b2.md` stub stands in for: local original on the Mac, streamed from B2 on the server. */
export const b2Url = (stubPath: string, download = false): string =>
  url('/b2', download ? { path: stubPath, download: 1 } : { path: stubPath });

/** Mirrors the server's EDITABLE_EXTS; the server is still the one that decides. */
export const EDITABLE_EXTS = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.toml',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.sh', '.css', '.html', '.xml', '.svg', '.sql',
]);

/** Vault paths are slash-separated and go straight into the route. */
export const fileHref = (path: string): string =>
  `/file/${path.split('/').map(encodeURIComponent).join('/')}`;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}
