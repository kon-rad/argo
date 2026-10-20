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
  modules: ('ring' | 'agents' | 'projects' | 'org' | 'usage' | 'map' | 'tv' | 'voice' | 'livestream' | 'media')[];
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
  family: 'claude' | 'hermes' | 'org';
  description?: string;
  model?: string;
  team?: string | null;
}

/** A card for a bot with its tracker project and feature (task_links); status lives on the kanban. */
export interface TaskLink {
  task_id: string;
  board: string;
  title: string;
  project_slug: string | null;
  feature_slug: string | null;
  assignee: string;
  created_by: string;
  rounds: number;
  graph?: string | null;
  node?: string | null;
  kind?: string;
  work_type?: string | null;
  created_at: string;
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

export type PlanWindowName = 'five_hour' | 'seven_day';
export interface PlanCurrent {
  used_pct: number | null; left_pct: number | null; resets_at: string | null; observed_at: string;
  host: string; origin: string; reset_since_reading: boolean; last_pct: number;
}
export interface UsagePlan {
  current: Record<PlanWindowName, PlanCurrent | null>;
  history: { observed_at: string; window: PlanWindowName; used_pct: number }[];
}
export type CreditProvider = 'openrouter' | 'fal' | 'gemini';
export interface CreditRow {
  provider: CreditProvider; origin: 'api' | 'manual'; status: 'ok' | 'error' | 'unsupported'; observed_at: string;
  balance: number | null; total_credits: number | null; total_usage: number | null; currency: string; error: string | null; note: string | null;
}
export interface UsageCredits {
  providers: { provider: CreditProvider; latest: CreditRow | null; last_ok: CreditRow | null }[];
  history: { provider: CreditProvider; observed_at: string; balance: number; currency: string }[];
}
export interface UsageSeriesRow { bucket: string; key: string; input: number; cache_write: number; cache_read: number; output: number; calls: number }
/** The labels every call carries (usage_facts); a filter is `dimension=a,b` and a group is one dimension. */
export const USAGE_DIMENSIONS = ['agent', 'team', 'reason', 'action', 'work_type', 'project', 'feature', 'task', 'host', 'headless', 'surface', 'lane', 'model', 'source'] as const;
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];
export type UsageFilters = Partial<Record<UsageDimension, string[]>>;
export const USAGE_DIMENSION_LABELS: Record<UsageDimension, string> = {
  agent: 'bot', team: 'team', reason: 'woken by', action: 'action', work_type: 'work', project: 'project', feature: 'feature', task: 'card',
  host: 'host', headless: 'headless', surface: 'surface', lane: 'lane', model: 'model', source: 'runtime',
};
export function usageFilterParams(f: UsageFilters): Record<string, string> {
  return Object.fromEntries(USAGE_DIMENSIONS.filter((d) => f[d]?.length).map((d) => [d, f[d]!.join(',')]));
}
export interface UsageFacetValue { value: string; calls: number; tokens: number; output: number }
export interface UsageFacets { from: string; to: string; total: { calls: number; tokens: number }; facets: Record<UsageDimension, UsageFacetValue[]> }
/** surface, started_at and ended_at are null for archive-only sessions. */
export interface UsageSessionRow {
  source: string; host: string; external_id: string; title: string | null; surface: string | null;
  started_at: string | null; ended_at: string | null;
  calls: number; input: number; cache_write: number; cache_read: number; output: number; cost_usd: number | null;
  task_id: string | null; lane: string | null; archive_id: number | null;
  agent_name?: string | null; project_slug?: string | null; work_type?: string | null; runs?: number;
}
/** One `claude -p` run: a bot's wake or a lane's card, with its labels and token sums (tokens null when its calls are not in yet). */
export interface UsageRun {
  host: string; run_id?: string; session_id: string; task_id: string | null; lane: string | null; board: string | null; model: string | null;
  started_at: string | null; ended_at: string | null; duration_ms: number | null; num_turns: number | null; subtype: string | null;
  is_error: boolean | null; verify_name: string | null; verify_passed: boolean | null;
  verify_exit: number | null; verify_metric: number | null; verify_output: string | null;
  agent_name?: string | null; team_slug?: string | null; reason?: string | null; reasons?: { reason: string | null; ref: string | null }[];
  work_type?: string | null; project_slug?: string | null; feature_slug?: string | null; card_title?: string | null; resumed?: boolean | null;
  surface?: string; calls?: number | null; input?: number | null; cache_write?: number | null; cache_read?: number | null; output?: number | null;
}
export interface OrgWakeRow {
  agent_name: string; team_slug: string | null; role: string; wakes: number; done: number; open: number; routine: number;
  dm?: number; mention?: number; task?: number; tokens?: number; output?: number;
  avg_minutes: number | null; last_wake: string | null;
}
export interface UsageHost { slug: string; display: string; kind: 'laptop' | 'server' | 'pi'; chip: string | null; notes: string | null }
/** One row of /usage/agent-sessions: a session from any harness and host. `cost_usd` only for non-Claude harnesses (Hermes's own estimate). */
export interface AgentSessionRow {
  id: number; source: string; harness: string; profile: string | null; provider: string | null; host: string;
  external_id: string; parent_external_id: string | null; project: string | null; title: string | null; first_prompt: string | null;
  started_at: string | null; ended_at: string | null; steps: number; tool_calls: number; errors: number; subagents: number;
  models: string[]; calls: number; input: number; cache_write: number; cache_read: number; output: number; reasoning: number;
  cost_usd?: number | null;
}
export type AgentStepKind = 'prompt' | 'response' | 'thinking' | 'tool_call' | 'tool_result' | 'system' | 'meta';
export interface AgentStep {
  id: number; key: string; step: AgentStepKind; ts: string | null; text: string; length: number; truncated: boolean;
  toolName: string | null; toolCallId: string | null; isError: boolean | null; subagent: string | null;
  call: { model: string; input: number; cache_write: number; cache_read: number; output: number; reasoning: number } | null;
}
export interface AgentSessionRun {
  run_id: string; agent_name: string | null; task_id: string | null; lane: string | null; started_at: string | null;
  num_turns: number | null; subtype: string | null; verify_name: string | null; verify_passed: boolean | null;
  verify_metric: number | null; verify_output: string | null;
}
export interface AgentSessionFilters {
  harness?: string[]; host?: string[]; profile?: string[]; provider?: string[]; tool?: string[];
  q?: string; errors?: boolean; subagents?: boolean;
}
export type AgentSessionFacets = Record<'harness' | 'host' | 'profile' | 'provider' | 'tool', Array<{ value: string; n: number }>>;
const agentParams = (f: AgentSessionFilters): Params => ({
  harness: f.harness?.join(','), host: f.host?.join(','), profile: f.profile?.join(','), provider: f.provider?.join(','),
  tool: f.tool?.join(','), q: f.q, errors: f.errors ? '1' : undefined, subagents: f.subagents ? '1' : undefined,
});

export interface UsageMessage {
  id: number; seq: number; role: string; kind: string; ts: string | null; text: string; truncated: boolean; length: number;
  is_sidechain: boolean; call: { model: string; input: number; cache_write: number; cache_read: number; output: number; action?: string | null; tool?: string | null; run_id?: string | null } | null;
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
export type Stage = 'idea' | 'designing' | 'building' | 'testing' | 'live' | 'parked' | 'done';
export const STAGES: Stage[] = ['idea', 'designing', 'building', 'testing', 'live', 'parked', 'done'];

export interface TrackerVerification {
  kind: string;
  check: string;
  result: 'pass' | 'fail';
  evidence: string | null;
  at: string;
  by: string | null;
}

export interface TrackerFeature {
  id: number;
  slug: string;
  title: string;
  stage: Stage;
  health: string | null;
  owner: string | null;
  goals: string[];
  needs_owner: string | null;
  blocked_on: string | null;
  due: string | null;
  shipped_at: string | null;
  notes_path: string | null;
  updated_at: string;
  updated_by: string | null;
  days_in_stage: number;
  verification: TrackerVerification | null;
  verifications_total: number;
}

export interface TrackerProject {
  slug: string;
  title: string;
  team: string | null;
  division: string | null;
  area: string | null;
  stage: Stage;
  health: string | null;
  priority: number | null;
  goals: string[];
  needs_owner: string | null;
  blocked_on: string | null;
  due: string | null;
  devlog_path: string | null;
  design_path: string | null;
  updated_at: string;
  days_in_stage: number;
  next_action: string | null;
  features: TrackerFeature[];
  counts: Record<Stage, number>;
  progress: number | null;
}

export interface TrackerItem {
  project: string;
  feature: string | null;
  title: string;
  detail: string;
}

export interface TrackerGoal {
  code: string;
  horizon: string;
  goal: string;
  due: string | null;
  status: string;
  projects: string[];
  features: string[];
}

export interface TrackerRollup {
  slug: string;
  name: string;
  projects: string[];
  in_flight: number;
  shipped_7d: number;
  needs_owner: number;
  stages: Record<Stage, number>;
}

export interface TrackerReport {
  as_of: string | null;
  generated_at: string;
  totals: { projects: Record<Stage, number>; features: Record<Stage, number> };
  needs_owner: (TrackerItem & { priority: number | null; due: string | null })[];
  divisions: TrackerRollup[];
  teams: (TrackerRollup & { lead: string | null })[];
  goals: TrackerGoal[];
  gaps: {
    goals_uncovered: TrackerGoal[];
    unverified_shipped: TrackerItem[];
    failing: TrackerItem[];
    testing_unverified: TrackerItem[];
    stale: TrackerItem[];
    overdue: TrackerItem[];
    no_team: string[];
    no_division: string[];
    no_features: string[];
  };
  oldest: TrackerItem[];
  backlog: { total: number; by_project: { project: string; count: number; oldest_days: number }[] };
  moved_7d: { project: string; feature: string | null; title: string; from: string | null; to: string; at: string; by: string | null; note: string | null }[];
  shipped_7d: TrackerItem[];
  verified_7d: { pass: number; fail: number };
  projects: TrackerProject[];
}

export const AUTH_EXPIRED_EVENT = 'secondbrain:auth-expired';

export async function request<T>(path: string, params?: Params, init?: RequestInit): Promise<T> {
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

export interface VoiceSettings {
  /** Claude Code on this Mac speaks a one-line summary when a long task finishes. */
  autoSpeak: boolean;
  voice: string;
  minTaskSeconds: number;
}

export interface VoiceStatus {
  settings: VoiceSettings;
  server: { url: string; model: string; up: boolean };
}

/** A note read aloud by the Kokoro server on this Mac, as an MP3 blob. */
async function speakNote(path: string): Promise<{ audio: Blob; truncated: boolean }> {
  const res = await fetch(url('/voice/speak'), {
    credentials: 'same-origin',
    ...json('POST', { path }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiError(res.status, body?.error?.message ?? `${res.status} ${res.statusText}`);
  }
  return { audio: await res.blob(), truncated: res.headers.get('X-Speech-Truncated') === '1' };
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

// ---- the agent company (/org) ----

export type OrgKind = 'message' | 'status' | 'decision' | 'handoff' | 'question-for-owner' | 'standup' | 'reflection' | 'reply';

export interface OrgMessage {
  id: number;
  channel_slug: string;
  thread_id: number | null;
  author: string;
  kind: OrgKind;
  body: string;
  mentions: string[];
  urgent: boolean;
  task_id: string | null;
  project_slug: string | null;
  feature_slug: string | null;
  run_id: string | null;
  created_at: string;
}

export interface OrgChannel {
  slug: string;
  kind: 'team' | 'shared' | 'dm';
  purpose: string | null;
  members: number;
  unread: number;
}

export interface OrgMember {
  agent_name: string;
  can_post: boolean;
  role: string;
  team_slug: string | null;
  runtime: string;
}

export interface OrgCaps {
  wakes_per_day: number;
  cooldown_minutes: number;
  max_runtime_minutes: number;
  lane: string | null;
  routines: { name: string; at?: string; on?: string; kind?: string }[];
}

export interface OrgActivity {
  last_wake: string | null;
  wakes_today: number;
  open_wakeups: number;
  unread: number;
  last_post: string | null;
}

export interface OrgChartAgent {
  name: string;
  team_slug: string | null;
  team_name: string | null;
  runtime: string;
  role: string;
  reports_to: string | null;
  model: string | null;
  expertise: string | null;
  is_lead: boolean;
  session_id: string | null;
  session_started: string | null;
  activity: OrgActivity | null;
  caps: OrgCaps | null;
}

export interface OrgChart {
  teams: { slug: string; name: string; lead: string | null }[];
  agents: OrgChartAgent[];
}

export interface OrgApproval {
  id: number;
  task_id: string;
  pr_url: string | null;
  deploy_target: string | null;
  summary: string;
  requested_by: string;
  status: 'pending' | 'approved' | 'denied';
  ship_now: boolean;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  created_at: string;
}

export interface OrgFact {
  id: number;
  subject: string;
  claim: string;
  source: string;
  author: string;
  via: string | null;
  project_slug: string | null;
  confidence: 'confirmed' | 'inferred';
  valid_from: string;
}

export interface OrgWakeup {
  id: number;
  agent_name: string;
  reason: string;
  ref: string | null;
  created_at: string;
  claimed_at: string | null;
  done_at: string | null;
  claimed_by?: string | null;
  result?: string | null;
}

export interface OrgAgentPage {
  agent: { name: string; team_slug: string | null; runtime: string; role: string; reports_to: string | null; model: string | null; expertise: string | null };
  team: { slug: string; name: string; lead: string | null } | null;
  is_lead: boolean;
  reports: string[];
  channels: { slug: string; kind: string; unread: number }[];
  open_wakeups: OrgWakeup[];
  runs: OrgWakeup[];
  posts: OrgMessage[];
  caps: OrgCaps | null;
  prompt: string | null;
  memory: string | null;
  memory_path: string;
}

export const api = {
  tree: (path: string, offset = 0, limit = 200) =>
    request<TreeResponse>('/tree', { path, offset, limit }),
  file: (path: string) => request<FileResponse>('/file', { path }),
  /** Each ref (a vault path or a wikilink name) to the indexed path it points at, or null. */
  resolveRefs: (refs: string[]) =>
    request<{ resolved: Record<string, string | null> }>(
      `/file/resolve?${new URLSearchParams(refs.map((ref) => ['ref', ref])).toString()}`,
    ),
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
  voiceStatus: () => request<VoiceStatus>('/voice/settings'),
  setVoiceSettings: (patch: Partial<VoiceSettings>) =>
    request<{ settings: VoiceSettings }>('/voice/settings', undefined, json('PUT', patch)),
  speakNote,
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
  hubAgents: () => request<{ lanes: HubAgent[]; profiles: HubAgent[]; bots?: HubAgent[] }>('/hub/agents'),
  boards: () => request<{ boards: { slug: string; name: string }[] }>('/hub/boards'),
  board: (board: string) => request<{ board: string; tasks: KanbanTask[] }>('/hub/board', { board }),
  task: (id: string, board: string) => request<KanbanTaskDetail>(`/hub/tasks/${id}`, { board }),
  taskLog: (id: string, offset: number) => request<EventPage>(`/hub/tasks/${id}/log`, { offset }),
  createTask: (t: { board: string; title: string; body: string; assignee: string; project?: string; feature?: string }) =>
    request<KanbanTask & { link?: TaskLink }>('/hub/tasks', undefined, json('POST', t)),
  commentTask: (id: string, board: string, text: string) =>
    request<{ ok: true }>(`/hub/tasks/${id}/comment`, undefined, json('POST', { board, text })),
  /** Moves a card to a lane, a Hermes profile or a bot (a bot needs the tracker project; "none" unassigns). */
  assignTask: (id: string, t: { board: string; assignee: string; project?: string; feature?: string }) =>
    request<KanbanTask & { link?: TaskLink }>(`/hub/tasks/${id}/assign`, undefined, json('POST', t)),
  claudeChats: () => request<{ chats: ClaudeChat[] }>('/hub/chats'),
  newClaudeChat: (model?: string) => request<ClaudeChat>('/hub/chats', undefined, json('POST', model ? { model } : {})),
  claudeChatEvents: (id: string, offset: number) =>
    request<EventPage & { chat: ClaudeChat }>(`/hub/chats/${id}/events`, { offset }),
  sendClaudeChat: (id: string, text: string) =>
    request<ClaudeChat>(`/hub/chats/${id}/messages`, undefined, json('POST', { text })),
  stopClaudeChat: (id: string) => request<{ ok: true }>(`/hub/chats/${id}/interrupt`, undefined, { method: 'POST' }),
  meta: () => request<AppMeta>('/meta'),
  projectsReport: () => request<TrackerReport>('/projects/report'),
  projectsMarkdown: () => request<{ text: string; as_of: string | null }>('/projects/report', { format: 'markdown' }),
  orgChart: () => request<OrgChart>('/org/chart'),
  orgChannels: () => request<{ channels: OrgChannel[] }>('/org/channels'),
  orgMembers: (slug: string) => request<{ members: OrgMember[] }>(`/org/channels/${encodeURIComponent(slug)}/members`),
  orgMarkRead: (slug: string) => request<{ ok: true }>(`/org/channels/${encodeURIComponent(slug)}/read`, undefined, { method: 'POST' }),
  orgMessages: (opts: { channel?: string; after?: number; before?: number; limit?: number }) =>
    request<{ messages: OrgMessage[]; cursor: number }>('/org/messages', opts),
  orgThread: (id: number) => request<{ messages: OrgMessage[] }>(`/org/thread/${id}`),
  orgSearch: (q: string) => request<{ messages: OrgMessage[] }>('/org/search', { q }),
  orgAgent: (name: string) => request<OrgAgentPage>(`/org/agents/${encodeURIComponent(name)}`),
  orgPost: (body: { channel: string; body: string; thread?: number; kind?: 'message' | 'status' | 'decision' }) =>
    request<OrgMessage>('/org/post', undefined, json('POST', body)),
  orgDm: (body: { to: string; body: string }) => request<OrgMessage>('/org/dm', undefined, json('POST', body)),
  orgApprovals: () => request<OrgApproval[]>('/org/approvals'),
  orgDecide: (id: number, decision: 'approve' | 'deny', note?: string) =>
    request<OrgApproval>(`/org/approvals/${id}/${decision}`, undefined, json('POST', { note })),
  orgFacts: () => request<OrgFact[]>('/org/facts'),
  orgTasks: (f: { project?: string; feature?: string; agent?: string } = {}) => request<{ tasks: TaskLink[] }>('/org/tasks', f),
  setProject: (slug: string, patch: Record<string, unknown>) =>
    request<{ stage_changed: boolean }>(`/projects/${slug}`, undefined, json('PATCH', patch)),
  setFeature: (slug: string, feature: string, patch: Record<string, unknown>) =>
    request<{ stage_changed: boolean }>(`/projects/${slug}/features/${feature}`, undefined, json('PATCH', patch)),
  verifyFeature: (slug: string, feature: string, v: { kind: string; check: string; result: 'pass' | 'fail'; evidence?: string }) =>
    request<{ id: number }>(`/projects/${slug}/features/${feature}/verifications`, undefined, json('POST', v)),
  source: (path: string) => request<FileSource>('/file/source', { path }),
  save: (path: string, content: string, baseHash: string) =>
    request<{ path: string; hash: string; mtime: string; size_bytes: number }>(
      '/file/source',
      undefined,
      json('PUT', { path, content, base_hash: baseHash }),
    ),
  usagePlan: (from?: string, to?: string) => request<UsagePlan>('/usage/plan', { from, to }),
  usageCredits: (from?: string, to?: string) => request<UsageCredits>('/usage/credits', { from, to }),
  usageSeries: (p: { from: string; to: string; bucket: 'hour' | 'day'; tz: string; group: 'type' | UsageDimension }, f: UsageFilters = {}) =>
    request<{ bucket: string; tz: string; rows: UsageSeriesRow[] }>('/usage/series', { ...p, ...usageFilterParams(f) }),
  usageFacets: (from: string, to: string, f: UsageFilters = {}) => request<UsageFacets>('/usage/facets', { from, to, ...usageFilterParams(f) }),
  usageHosts: () => request<{ hosts: UsageHost[] }>('/usage/hosts'),
  usageSessions: (from: string, to: string, f: UsageFilters = {}) => request<{ sessions: UsageSessionRow[] }>('/usage/sessions', { from, to, ...usageFilterParams(f) }),
  usageSession: (host: string, externalId: string, source: string) =>
    request<{ session: UsageSessionRow; run: UsageRun | null; runs?: UsageRun[]; messages: UsageMessage[] }>(
      `/usage/sessions/${encodeURIComponent(host)}/${encodeURIComponent(externalId)}`, { source }),
  usageMessage: (id: number, full = false, part?: string) =>
    request<{ id: number; raw: unknown; text?: string }>(`/usage/messages/${id}`, { full: full ? '1' : undefined, part }),
  agentSessions: (from: string, to: string, f: AgentSessionFilters = {}, offset = 0) =>
    request<{ sessions: AgentSessionRow[]; total: number }>('/usage/agent-sessions', { from, to, offset, ...agentParams(f) }),
  agentSessionFacets: (from: string, to: string) => request<{ facets: AgentSessionFacets }>('/usage/agent-sessions/facets', { from, to }),
  agentSession: (host: string, externalId: string, source: string | null, offset = 0) =>
    request<{ session: AgentSessionRow; runs: AgentSessionRun[]; steps: AgentStep[]; next: number | null }>(
      `/usage/agent-sessions/${encodeURIComponent(host)}/${encodeURIComponent(externalId)}`, { source: source ?? undefined, offset }),
  usageRuns: (from: string, to: string, f: UsageFilters = {}) => request<{ runs: UsageRun[] }>('/usage/runs', { from, to, ...usageFilterParams(f) }),
  usageOrgWakes: (from: string, to: string) => request<{ agents: OrgWakeRow[] }>('/usage/org-wakes', { from, to }),
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

/** One tv module episode, as /api/tv/episodes lists it from the vault's episode notes. */
export interface TvEpisode {
  id: string;
  title: string;
  show: string;
  generated_at: string | null;
  duration_s: number | null;
  voice: string | null;
  note: string;
  video: string | null;
  source: 'local' | 'b2' | null;
}

export const tvApi = {
  episodes: () =>
    request<{ episodes: TvEpisode[]; shows: Record<string, string>; episodesDir: string }>('/tv/episodes'),
};

export type MediaKind = 'image' | 'video' | 'audio';

export interface MediaItem {
  path: string;
  folder: string;
  name: string;
  ext: string;
  kind: MediaKind;
  size_bytes: number | null;
  mtime: string | null;
  /** 'b2' when only a .b2.md stub is here and the file streams from B2. */
  source: 'local' | 'b2';
  /** False when the index lists the file but this machine's disk doesn't have it. */
  available: boolean;
  url: string;
}

export interface MediaQuery {
  kind?: 'all' | MediaKind;
  path?: string;
  q?: string;
  sort?: 'new' | 'name' | 'size';
  limit?: number;
  offset?: number;
}

export interface MediaResponse {
  items: MediaItem[];
  total: number;
  has_more: boolean;
  counts: Record<MediaKind, number>;
  folders: { path: string; count: number }[];
}

export const mediaApi = {
  list: (q: MediaQuery) => request<MediaResponse>('/media', { ...q }),
};

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
