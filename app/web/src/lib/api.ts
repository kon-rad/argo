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

export type SearchScope = 'notes' | 'records' | 'agents';

export interface RecordHit {
  table: string;
  label: string;
  id: string;
  title: string;
  snippet: string;
  notes_path: string | null;
}

export interface AgentHit {
  host: string;
  source: string;
  external_id: string;
  harness: string | null;
  session_title: string | null;
  step: string | null;
  role: string;
  seq: number;
  ts: string | null;
  snippet: string;
}

export interface SearchSection<T> {
  results: T[];
  total: number;
  has_more: boolean;
  error?: string;
  degraded?: boolean;
}

export interface GlobalSearchResponse {
  q: string;
  mode: SearchMode;
  available: SearchScope[];
  notes?: SearchSection<SearchHit>;
  records?: SearchSection<RecordHit>;
  agents?: SearchSection<AgentHit>;
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

export interface FundTokenBalance { symbol: string; amount: number; usd: number | null }
export interface FundWallet {
  key: 'safe' | 'agent' | 'deck' | 'phone' | 'savings';
  label: string;
  role: string;
  address: string | null;
  balances: FundTokenBalance[];
  usd: number | null;
  partial: boolean;
  error: string | null;
}
export interface FundVote { partner: string; vote: string; reason: string }
export interface FundProposal {
  id: string; created: string; kind: string; title: string; status: string; tally: string; meeting: string;
  votes: FundVote[]; txHash: string | null; result: string | null;
}
export interface FundTransaction {
  when: string;
  kind: 'swap' | 'withdraw' | 'transfer-in' | 'transfer-out' | 'failed' | 'refused' | 'expired';
  title: string;
  hash: string | null;
  proposal: string | null;
  confirmed: boolean | null;
  gasEth: number | null;
}
export interface FundFileItem { name: string; path: string; title: string; note: string }
export interface FundRun { skill: string; at: string; failed: boolean; reason: string | null; file: string }
export interface FundOverview {
  configured: boolean;
  dir: string;
  chainId: number | null;
  explorer: string;
  threshold: number | null;
  ethUsd: number | null;
  navUsd: number | null;
  navPartial: boolean;
  wallets: FundWallet[];
  pending: FundProposal[];
  proposals: FundProposal[];
  transactions: FundTransaction[];
  meetings: FundFileItem[];
  research: FundFileItem[];
  reviews: FundFileItem[];
  harness: { header: string[]; rows: string[][] };
  runs: FundRun[];
  warnings: string[];
  chainErrors: string[];
  asOf: string;
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
  modules: ('ring' | 'agents' | 'projects' | 'org' | 'board' | 'usage' | 'map' | 'tv' | 'voice' | 'livestream' | 'media' | 'fund' | 'social' | 'chat')[];
  owner: string;
  devLogPath: string | null;
  docsPath: string | null;
  robot: boolean;
  /** The app's own version, from package.json, and the commit it was built from. */
  version: string;
  commit: string | null;
  commitShort: string | null;
  builtAt: string | null;
}

/** This machine's vault sync (server: GET /api/sync). `installed: false` when no sync runs here. */
export type SyncState =
  | { installed: false }
  | {
      installed: true;
      machine: string;
      role: string;
      policy: string;
      last_run: string | null;
      last_success: string | null;
      last_result: string | null;
      last_error: string | null;
      ahead: number;
      behind: number;
      conflict_files: string[];
      push_failures: number;
    };

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

/** A card for a bot with its tracker project and feature (GET /api/org/tasks, read from the board's cards). */
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

// ---- the board module: the kanban record in the engine (/api/board) ----

export const BOARD_STATUSES = ['triage', 'todo', 'scheduled', 'ready', 'running', 'review', 'blocked', 'done', 'archived'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

export interface BoardContract {
  objective?: string;
  returns?: string[];
  budget?: { turns?: number; tokens?: number; minutes?: number; wakes?: number };
  scope?: string[];
  verification?: string;
}

export interface BoardCard {
  id: string;
  board_slug: string;
  title: string;
  body: string | null;
  contract: BoardContract;
  status: BoardStatus;
  priority: number;
  assignee: string | null;
  created_by: string;
  project_slug: string | null;
  feature_slug: string | null;
  kind: string;
  work_type: string | null;
  needs: string | null;
  ship_now: boolean;
  repo: string | null;
  graph: string | null;
  node: string | null;
  rounds: number;
  scheduled_for: string | null;
  block_kind: string | null;
  block_reason: string | null;
  result: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface BoardCardDetail {
  card: BoardCard;
  comments: { id: number; author: string; body: string; created_at: string }[];
  events: { id: number; kind: string; actor: string | null; payload: Record<string, unknown> | null; at: string }[];
  depends_on: { id: string; title: string; status: string }[];
  dependants: { id: string; title: string; status: string }[];
  runs: { id: number; agent_name: string; runtime: string; claimed_at: string; lease_until: string; heartbeat_at: string | null; finished_at: string | null; outcome: string | null; tokens: number | null; turns: number | null }[];
}

export interface BoardInfo {
  slug: string;
  name: string;
  team_slug: string | null;
  open: number;
}

export interface BoardToken {
  id: number;
  agent_name: string;
  label: string | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

export interface BoardCardFilter {
  board?: string;
  status?: string;
  assignee?: string;
  project?: string;
  feature?: string;
  kind?: string;
  q?: string;
  done_days?: number;
}

export interface NewBoardCard {
  board?: string;
  title: string;
  body?: string;
  contract?: BoardContract;
  assignee?: string | null;
  project?: string;
  feature?: string;
  kind?: string;
  work?: string;
  needs?: string;
  repo?: string;
  priority?: number;
  deps?: string[];
  ship_now?: boolean;
}

/** One line of a Claude Code stream-json log (or a line agent-hub added: "you", "hub"). */
export type StreamEvent = Record<string, unknown> & { type: string };

export interface EventPage {
  events: StreamEvent[];
  offset: number;
  size: number;
  /** Set by hosts whose log lives in memory: a new value means the log was rebuilt (a restart) and the reader starts over. */
  epoch?: string;
}

/** `zen-agent serve` behind /api/zen: one row per provider and per model, with what the pickers grey out. */
export interface ZenProvider {
  id: string;
  name: string;
  /** From zen.json's `providers` (a local or custom endpoint), not one pi-ai ships. */
  custom: boolean;
  /** A key (or keyless auth) resolves on the server. Never the key itself. */
  configured: boolean;
  /** The environment variable a custom endpoint's key comes from. */
  key_env: string | null;
  key_name: string | null;
  base_url: string | null;
  /** Custom endpoints only: the host's liveness probe answered. */
  reachable: boolean | null;
}
export interface ZenModel {
  provider: string;
  id: string;
  name: string;
  context_window: number;
  reasoning: boolean;
  configured: boolean;
  reachable: boolean | null;
}
export interface ZenPersona { name: string; role: string; team: string | null; runtime: string }
export const ZEN_THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ZenThinking = (typeof ZEN_THINKING)[number];
export interface ZenUsage { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number }
/** A zen-agent chat: its config is fixed for its life; "continue as a new session" makes another with `from` set. */
export interface ZenChat {
  id: string;
  title: string;
  session_id: string;
  persona: string | null;
  model: string;
  tools: string[];
  thinking: ZenThinking;
  from: string | null;
  created_at: string;
  updated_at: string;
  status: 'idle' | 'working' | 'error';
  error: string | null;
  turns: number;
  usage: ZenUsage;
}
export interface NewZenChat {
  persona?: string | null;
  model?: string;
  tools?: 'full' | 'read-only' | string[];
  thinking?: ZenThinking;
  title?: string;
  from?: string;
}

/** A saved way to start a chat (the Chat tab's Preset button). Launching it is the create call of its harness. */
export interface ChatPreset {
  name: string;
  harness: 'claude-code' | 'zen-agent';
  config: { model?: string; role?: string; persona?: string; tools?: 'full' | 'read-only'; thinking?: ZenThinking };
  updated_at: string;
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
export const USAGE_DIMENSIONS = ['agent', 'team', 'reason', 'action', 'work_type', 'project', 'feature', 'task', 'host', 'headless', 'surface', 'lane', 'model', 'provider', 'source'] as const;
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];
export type UsageFilters = Partial<Record<UsageDimension, string[]>>;
export const USAGE_DIMENSION_LABELS: Record<UsageDimension, string> = {
  agent: 'bot', team: 'team', reason: 'woken by', action: 'action', work_type: 'work', project: 'project', feature: 'feature', task: 'card',
  host: 'host', headless: 'headless', surface: 'surface', lane: 'lane', model: 'model', provider: 'provider', source: 'runtime',
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
/** One headless run (claude-code or zen-agent): a bot's wake or a lane's card, with its labels and token sums (tokens null when its calls are not in yet). */
export interface UsageRun {
  host: string; run_id?: string; session_id: string; task_id: string | null; lane: string | null; board: string | null; model: string | null;
  started_at: string | null; ended_at: string | null; duration_ms: number | null; num_turns: number | null; subtype: string | null;
  is_error: boolean | null; verify_name: string | null; verify_passed: boolean | null;
  verify_exit: number | null; verify_metric: number | null; verify_output: string | null;
  agent_name?: string | null; team_slug?: string | null; reason?: string | null; reasons?: { reason: string | null; ref: string | null }[];
  work_type?: string | null; project_slug?: string | null; feature_slug?: string | null; card_title?: string | null; resumed?: boolean | null;
  surface?: string; calls?: number | null; input?: number | null; cache_write?: number | null; cache_read?: number | null; output?: number | null;
  /** 'claude-code' or 'zen-agent'; cost_usd is real dollars for an API runtime and null for the subscription. */
  runtime?: string; source?: string; tier?: string | null; outcome?: string | null; cost_usd?: number | null;
  compactions?: number | null; blocked?: number | null;
}
export interface OrgWakeRow {
  agent_name: string; team_slug: string | null; role: string; wakes: number; done: number; open: number; routine: number;
  dm?: number; mention?: number; task?: number; tokens?: number; output?: number;
  avg_minutes: number | null; last_wake: string | null;
}
/** One agent process (or an unfinished claim) alive on the server's host right now: GET /usage/running. */
export interface RunningRow {
  kind: 'bot' | 'lane' | 'other'; name: string; runtime: string; model: string | null; pid: number | null; user: string | null;
  elapsedSec: number | null; startedAt: string | null; runId: string | null; reason: string | null; ref: string | null;
  state: 'running' | 'claimed'; configured: { runtime: string; model: string | null } | null; detail: string | null;
}
export interface RunningNow { host: string; at: string; rows: RunningRow[]; configured: Record<string, number> }
export interface UsageHost { slug: string; display: string; kind: 'laptop' | 'server' | 'pi'; chip: string | null; notes: string | null }
/** One summary of a finished agent session (`secondbrain summarize`). touched and metrics are computed, the rest is model-written. */
export interface AgentSummary {
  id: number; session_id: number; harness: string | null; host: string; profile: string | null; project: string | null;
  started_at: string | null; ended_at: string | null; request: string; done: string; learned: string; open_items: string;
  outcome: 'finished' | 'partial' | 'blocked' | 'failed' | 'unknown';
  touched: { files_edited: string[]; files_read: number; cards: string[]; tools: Record<string, number>; skills: string[] };
  metrics: { steps: number; prompts: number; tool_calls: number; error_steps: number; duration_s: number | null; calls: number;
    input_tokens: number; cache_write_tokens: number; cache_read_tokens: number; output_tokens: number; models: string[] };
  writer_provider: string | null; writer_model: string | null; title: string | null; external_id: string; source: string; proposed_facts: number;
}
export interface SummaryFilters { outcome?: string[]; harness?: string[]; host?: string[]; project?: string[]; q?: string }
export interface SummaryOverview {
  from: string; to: string; tz: string; summarized: number; skipped: number; proposed_facts: number;
  outcomes: { key: string; n: number }[];
  days: { day: string; sessions: number; finished: number; stuck: number; tokens: number; errors_per_session: number }[];
  writers: { key: string; n: number; input: number; output: number }[];
}
export interface SummaryFact {
  id: number; summary_id: number; subject: string; claim: string; status: 'proposed' | 'promoted' | 'rejected'; fact_id: number | null;
  project: string | null; harness: string | null; host: string; session_id: number; external_id: string; source: string; request: string;
}
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

// ---- the chat module (/api/chat) ----

export interface ChatProviderOption {
  id: string;
  label: string;
  configured: boolean;
  env: string | null;
  default: string;
  models: { id: string; label?: string }[];
  /** A connected computer running Ollama; `offline` when it did not answer. */
  machine?: boolean;
  offline?: boolean;
}

export interface ChatPersona {
  id: string;
  name: string;
  role: string;
  team: string | null;
  builtin: boolean;
}

export interface ChatRetrieval {
  top_k: number;
  multi_query: boolean;
  rerank: boolean;
}

export interface ChatSettings {
  provider: string | null;
  model: string | null;
  persona: string;
  system_prompt: string | null;
  retrieval: ChatRetrieval;
  resolved: { provider: string | null; model: string | null; system_prompt: string; rerank_available: boolean; embeddings: boolean };
}

export interface ChatSettingsPatch {
  provider?: string | null;
  model?: string | null;
  persona?: string;
  system_prompt?: string | null;
  retrieval?: Partial<ChatRetrieval>;
}

export interface ChatOptions {
  providers: ChatProviderOption[];
  default_provider: string;
  default_system_prompt: string;
  personas: ChatPersona[];
  settings: ChatSettings;
  embeddings: { chunks: number; model: string | null; configured: boolean };
  rerank: { available: boolean; model: string };
}

export interface ChatConversation {
  id: number;
  title: string;
  persona: string;
  provider: string | null;
  model: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface ChatSource {
  n: number;
  path: string;
  title: string;
  heading_path: string;
  chunk_from: number;
  chunk_to: number;
  score: number;
  snippet: string;
}

export interface ChatMessage {
  id: number;
  conversation_id: number;
  role: 'user' | 'assistant';
  content: string;
  sources: ChatSource[];
  meta: { provider?: string; model?: string; persona?: string; error?: string; partial?: boolean; retrieval?: { queries?: string[]; vector?: boolean; keyword?: boolean; reranked?: boolean; ms?: number } };
  created_at: string;
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
  core: string | null;
  core_path: string;
  memory_rows: OrgMemoryRow[];
  episodes: OrgEpisode[];
  proposals: (OrgMemoryRow & { card_status: string | null; card_title: string | null })[];
  memory_stats: OrgMemoryStats;
  memory_config: { core_budget_tokens: number; reflect: { enabled: boolean; min_turns: number }; self_improvement: { enabled: boolean; repeat_threshold: number; max_proposals_per_week: number } } | null;
}

export interface OrgMemoryRow {
  id: number;
  agent_name: string;
  kind: 'lesson' | 'anti_pattern' | 'preference' | 'friction';
  content: string;
  evidence_episode_ids: number[];
  occurrences: number;
  active: boolean;
  retired_why: string | null;
  supersedes: number | null;
  promoted_to_proposal: boolean;
  proposal_task_id: string | null;
  proposed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrgEpisode {
  id: number;
  run_id: string;
  task_id: string | null;
  reason: string;
  outcome: 'done' | 'blocked' | 'request_changes' | 'no_report' | 'error';
  corrected: boolean;
  turn_count: number | null;
  cost_usd: string | null;
  duration_s: number | null;
  summary: string;
  log_path: string | null;
  reflected_at: string | null;
  created_at: string;
}

export interface OrgMemoryStats {
  days: number;
  episodes: number;
  done: number;
  corrected: number;
  corrections_per_done: number | null;
  cost_per_done: number | null;
  avg_turns: number | null;
  reflected: number;
  memory: { active: number; by_kind: Record<string, number> };
  proposals: number;
}

export const api = {
  chatOptions: () => request<ChatOptions>('/chat/options'),
  chatSettings: () => request<{ settings: ChatSettings }>('/chat/settings'),
  putChatSettings: (patch: ChatSettingsPatch) => request<{ settings: ChatSettings }>('/chat/settings', undefined, json('PUT', patch)),
  chatConversations: () => request<{ conversations: ChatConversation[] }>('/chat/conversations'),
  newChatConversation: (body: { persona?: string } = {}) =>
    request<{ conversation: ChatConversation }>('/chat/conversations', undefined, json('POST', body)),
  chatConversation: (id: number) => request<{ conversation: ChatConversation; messages: ChatMessage[] }>(`/chat/conversations/${id}`),
  patchChatConversation: (id: number, patch: { title?: string; persona?: string }) =>
    request<{ conversation: ChatConversation }>(`/chat/conversations/${id}`, undefined, json('PATCH', patch)),
  deleteChatConversation: async (id: number): Promise<void> => {
    const res = await fetch(url(`/chat/conversations/${id}`), { method: 'DELETE', credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  },
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
  globalSearch: (q: string, scopes: SearchScope[], mode: SearchMode, offset = 0, limit = 10) =>
    request<GlobalSearchResponse>('/search/global', { q, scopes: scopes.join(','), mode, offset, limit }),
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
  claudeChats: () => request<{ chats: ClaudeChat[] }>('/hub/chats'),
  chatPresets: () => request<{ presets: ChatPreset[] }>('/presets'),
  putChatPreset: (name: string, body: Pick<ChatPreset, 'harness' | 'config'>) =>
    request<{ preset: ChatPreset }>(`/presets/${name}`, undefined, json('PUT', body)),
  deleteChatPreset: (name: string) => request<{ ok: true }>(`/presets/${name}`, undefined, { method: 'DELETE' }),
  newClaudeChat: (model?: string) => request<ClaudeChat>('/hub/chats', undefined, json('POST', model ? { model } : {})),
  claudeChatEvents: (id: string, offset: number) =>
    request<EventPage & { chat: ClaudeChat }>(`/hub/chats/${id}/events`, { offset }),
  sendClaudeChat: (id: string, text: string) =>
    request<ClaudeChat>(`/hub/chats/${id}/messages`, undefined, json('POST', { text })),
  stopClaudeChat: (id: string) => request<{ ok: true }>(`/hub/chats/${id}/interrupt`, undefined, { method: 'POST' }),
  zenModels: () => request<{ providers: ZenProvider[]; models: ZenModel[] }>('/zen/models'),
  zenPersonas: () => request<{ personas: ZenPersona[] }>('/zen/personas'),
  zenChats: () => request<{ chats: ZenChat[] }>('/zen/chats'),
  newZenChat: (body: NewZenChat) => request<ZenChat>('/zen/chats', undefined, json('POST', body)),
  zenChat: (id: string) => request<ZenChat>(`/zen/chats/${id}`),
  zenChatEvents: (id: string, offset: number) =>
    request<EventPage & { chat: ZenChat; epoch: string }>(`/zen/chats/${id}/events`, { offset }),
  sendZenChat: (id: string, text: string) => request<ZenChat>(`/zen/chats/${id}/messages`, undefined, json('POST', { text })),
  steerZenChat: (id: string, text: string) => request<ZenChat>(`/zen/chats/${id}/steer`, undefined, json('POST', { text })),
  stopZenChat: (id: string) => request<{ ok: true; chat: ZenChat }>(`/zen/chats/${id}/interrupt`, undefined, { method: 'POST' }),
  meta: () => request<AppMeta>('/meta'),
  syncState: () => request<SyncState>('/sync'),
  fund: (refresh = false) => request<FundOverview>('/fund', refresh ? { refresh: '1' } : undefined),
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
  orgTasks: (f: { project?: string; feature?: string; agent?: string } = {}) => request<{ tasks: (TaskLink & { status?: string })[] }>('/org/tasks', f),

  // The board module.
  boardBoards: () => request<{ boards: BoardInfo[] }>('/board/boards'),
  boardCards: (f: BoardCardFilter = {}) => request<{ cards: BoardCard[] }>('/board/cards', f as Params),
  boardCard: (id: string) => request<BoardCardDetail>(`/board/cards/${id}`),
  boardCreate: (c: NewBoardCard) => request<{ card: BoardCard; message: OrgMessage | null }>('/board/cards', undefined, json('POST', c)),
  boardComment: (id: string, body: string) => request<{ comment: BoardCardDetail['comments'][number] }>(`/board/cards/${id}/comment`, undefined, json('POST', { body })),
  boardAssign: (id: string, t: { assignee: string | null; project?: string; feature?: string }) => request<{ card: BoardCard }>(`/board/cards/${id}/assign`, undefined, json('POST', t)),
  boardMove: (id: string, status: BoardStatus, note?: string) => request<{ card: BoardCard }>(`/board/cards/${id}/move`, undefined, json('POST', { status, note })),
  boardFinish: (id: string, b: { outcome: 'done' | 'blocked' | 'partial' | 'budget'; result?: string; block_kind?: string }) => request<{ card: BoardCard }>(`/board/cards/${id}/finish`, undefined, json('POST', b)),
  boardFlags: (id: string, b: { ship_now?: boolean; needs?: string }) => request<{ card: BoardCard }>(`/board/cards/${id}/flags`, undefined, json('POST', b)),
  boardLink: (id: string, dependsOn: string) => request<{ ok: true }>(`/board/cards/${id}/link`, undefined, json('POST', { depends_on: dependsOn })),
  boardLog: (id: string, offset: number) => request<EventPage>(`/board/cards/${id}/log`, { offset }),
  boardTokens: () => request<{ tokens: BoardToken[] }>('/board/tokens'),
  boardRevokeToken: (id: number) => request<{ ok: true }>(`/board/tokens/${id}/revoke`, undefined, { method: 'POST' }),
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
  summaries: (from: string, to: string, f: SummaryFilters = {}) =>
    request<{ summaries: AgentSummary[] }>('/summaries', { from, to, q: f.q, outcome: f.outcome?.join(','), harness: f.harness?.join(','), host: f.host?.join(','), project: f.project?.join(',') }),
  summaryOverview: (from: string, to: string, tz: string) => request<SummaryOverview>('/summaries/overview', { from, to, tz }),
  summaryFacts: (status: 'proposed' | 'promoted' | 'rejected' = 'proposed') => request<{ facts: SummaryFact[] }>('/summaries/facts', { status }),
  promoteSummaryFact: (id: number) => request<{ id: number; fact_id: number }>(`/summaries/facts/${id}/promote`, undefined, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  rejectSummaryFact: (id: number) => request<{ id: number }>(`/summaries/facts/${id}/reject`, undefined, { method: 'POST' }),
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
  usageRunning: () => request<RunningNow>('/usage/running'),
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
