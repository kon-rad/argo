import type { DeskOperatorApi, OperatorJob, Provider, ReleaseRequest, Approval, Mutation, Result, WorkerResult } from '@secondbrain/desk-contracts/desk';

type JsonObject = Record<string, unknown>;

async function request<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const response = await fetch(path, {
      ...init,
      headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
    });
    const body = (await response.json().catch(() => ({}))) as JsonObject;
    if (!response.ok) {
      const nestedError = body.error && typeof body.error === 'object' ? body.error as JsonObject : undefined;
      const message = typeof body.message === 'string'
        ? body.message
        : typeof nestedError?.message === 'string'
          ? nestedError.message
          : `Desk request failed (${response.status})`;
      return response.status === 409
        ? { kind: 'failed', message: `STALE_REVISION: ${message}` }
        : response.status === 401 || response.status === 403
          ? { kind: 'denied', message }
          : response.status >= 500
            ? { kind: 'unavailable', message }
            : { kind: 'failed', message };
    }
    if (body && typeof body === 'object' && 'kind' in body && typeof body.kind === 'string' && body.kind !== 'ok') {
      return body as Result<T>;
    }
    return { kind: 'ok', value: ('value' in body ? body.value : body) as T };
  } catch (error) {
    return { kind: 'unavailable', message: error instanceof Error ? error.message : 'Desk service is unavailable' };
  }
}

const json = (value: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(value) });
const jobPath = (id: string) => `/api/desk/jobs/${encodeURIComponent(id)}`;

/** Browser adapter for the private operator endpoints. Pass a fake API directly to Desk in tests or fixture mode. */
export function createHttpDeskOperatorApi(): DeskOperatorApi {
  return {
    mode: 'live',
    inbox: () => request<OperatorJob[]>('/api/desk/inbox'),
    jobs: () => request<OperatorJob[]>('/api/desk/jobs'),
    job: (id) => request<OperatorJob>(jobPath(id)),
    providers: () => request<Provider[]>('/api/desk/providers'),
    approve: (id, payload: Approval) => request<OperatorJob>(`${jobPath(id)}/approve`, json(payload)),
    decline: (id, payload: Mutation) => request<OperatorJob>(`${jobPath(id)}/decline`, json(payload)),
    cancel: (id, payload: Mutation) => request<OperatorJob>(`${jobPath(id)}/cancel`, json(payload)),
    preview: (id) => request<WorkerResult>(`${jobPath(id)}/preview`),
    release: (id, payload: ReleaseRequest) => request<OperatorJob>(`${jobPath(id)}/release`, json(payload)),
  };
}

/** Stable-shaped fixture helper; values stay synthetic and every method is replaceable in UI tests. */
export function createUnavailableDeskOperatorApi(message = 'Operator API is not connected'): DeskOperatorApi {
  const unavailable: Result<never> = { kind: 'unavailable', message };
  return {
    mode: 'fixture', inbox: async () => unavailable, jobs: async () => unavailable,
    job: async () => unavailable, providers: async () => unavailable,
    approve: async () => unavailable, decline: async () => unavailable, cancel: async () => unavailable,
    preview: async () => unavailable, release: async () => unavailable,
  };
}
