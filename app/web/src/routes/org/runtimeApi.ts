import { json, request } from '../../lib/http.js';

export interface Target {
  kind: 'org-agent' | 'cron-job' | 'telegram-gateway' | 'telegram-poller' | 'default-route';
  id: string;
}
export interface Assignment { runtime: string; model: string | null; provider: string | null }
export interface RuntimeTarget extends Target {
  configured: Assignment;
  effective: Assignment;
  adapter: string | null;
  health: string;
  lastObserved: { runtime: string | null; model: string | null; started_at: string | null } | null;
}
export interface RuntimeProfile {
  id: string;
  version: number;
  definition: { name: string; default: Assignment; exceptions: Record<string, Assignment>; capabilities: Record<string, Assignment> };
}
export interface Change { target: Target; from: Assignment; to: Assignment; problem: string | null }
export interface Preview {
  token: string;
  profileId: string;
  profileVersion: number;
  rosterVersion: string;
  changes: Change[];
  uncovered: Target[];
  expiresAt: string;
  inFlight: { id: number | string; agent_name: string | null; runtime: string | null }[];
}
export interface ApplyResult { version: number; changes: Change[]; uncovered: Target[]; status: string }
export interface HistoryEntry extends ApplyResult {
  profile_id: string;
  profile_version: number;
  applied_by: string;
  created_at: string;
  reverted_version: number | null;
}
export interface Receipt { version: number; kind: Target['kind']; target_id: string; status: string; assignment: Assignment; observed_at: string | null }
export interface RuntimeStatus {
  desiredVersion: number;
  targets: RuntimeTarget[];
  profiles: RuntimeProfile[];
  profileRevisions: RuntimeProfile[];
  history: HistoryEntry[];
  receipts: Receipt[];
}
export const runtimeApi = {
  runtimeStatus: () => request<RuntimeStatus>('/org/runtime'),
  runtimePreview: (profileId: string, scope: Target[]) => request<Preview>('/org/runtime/preview', undefined, json('POST', { profileId, scope })),
  runtimeApply: (token: string) => request<ApplyResult>('/org/runtime/apply', undefined, json('POST', { token })),
  runtimeRevert: (version: number) => request<ApplyResult>('/org/runtime/revert', undefined, json('POST', { version })),
};
