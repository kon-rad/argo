import { createHash } from 'node:crypto';
import type { DeskRunner, Result, WorkerResult, WorkerSpec } from '@secondbrain/desk-contracts/desk';
import type { CapabilityIssuer } from '../orchestration/service.js';

const attemptPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const hashPattern = /^sha256:[a-f0-9]{64}$/;
export interface WorkerControlOptions { url: string; token: string; fetch?: typeof fetch; timeoutMs?: number; maxArtifactBytes?: number }
const unavailable = <T>(message: string): Result<T> => ({ kind: 'unavailable', message });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function resultMetadata(value: unknown, attemptId: string): WorkerResult | undefined {
  if (!isObject(value) || value.artifactRef !== `desk-worker:${attemptId}` || typeof value.artifactHash !== 'string' || !hashPattern.test(value.artifactHash) || value.mediaType !== 'text/markdown' || typeof value.boundedTrace !== 'string' || value.boundedTrace.length > 2000) return undefined;
  return { artifactRef: value.artifactRef, artifactHash: value.artifactHash, mediaType: 'text/markdown', boundedTrace: value.boundedTrace };
}

/** Server-only authenticated transport. No signing key, model credential or host path crosses this API. */
export class TrustedWorkerBridge implements DeskRunner, CapabilityIssuer {
  readonly mode = 'live' as const;
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  private readonly timeout: number;
  private readonly maxArtifact: number;
  constructor(private readonly options: WorkerControlOptions) {
    const url = new URL(options.url);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || options.token.length < 32) throw new Error('Trusted worker control requires an origin URL, HTTPS or loopback, and a server-only bearer token');
    this.base = url.origin;
    this.fetcher = options.fetch ?? fetch;
    this.timeout = options.timeoutMs ?? 20_000;
    this.maxArtifact = options.maxArtifactBytes ?? 1_000_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 60_000 || !Number.isSafeInteger(this.maxArtifact) || this.maxArtifact < 1 || this.maxArtifact > 1_000_000) throw new Error('Invalid worker transport bounds');
  }
  private validAttempt(attemptId: string) { return attemptPattern.test(attemptId); }
  private async call<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Result<T>> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const encoded = body === undefined ? undefined : JSON.stringify(body);
      if (encoded && Buffer.byteLength(encoded) > 32768) return { kind: 'invalid-input', message: 'Worker request exceeds control-plane limit' };
      const response = await this.fetcher(`${this.base}${path}`, { method, signal: controller.signal, redirect: 'error', headers: { Authorization: `Bearer ${this.options.token}`, Accept: 'application/json', ...(encoded ? { 'Content-Type': 'application/json' } : {}) }, ...(encoded ? { body: encoded } : {}) });
      const maxResponse = Math.ceil(this.maxArtifact * 4 / 3) + 16000;
      if (Number(response.headers.get('content-length')) > maxResponse) return unavailable('Worker response exceeds size bound');
      if (!response.body) return unavailable('Worker returned no response');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > maxResponse) { await reader.cancel(); return unavailable('Worker response exceeds size bound'); } chunks.push(chunk.value); }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!isObject(data)) return unavailable('Worker returned an unsupported response');
      if (response.ok && data.kind === 'ok' && 'value' in data) return { kind: 'ok', value: data.value as T };
      if (data.kind === 'denied') return { kind: 'denied', message: 'Worker control denied the approved-state binding' };
      if (data.kind === 'invalid-input') return { kind: 'invalid-input', message: 'Worker control rejected the request shape' };
      return unavailable('Isolated worker service unavailable');
    } catch { return unavailable('Isolated worker service unavailable'); }
    finally { clearTimeout(timer); }
  }
  async issue(spec: WorkerSpec): Promise<Result<string>> {
    const result = await this.call<unknown>('/v1/capabilities/issue', 'POST', { spec });
    if (result.kind !== 'ok') return result;
    return typeof result.value === 'string' && result.value.length <= 16000 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.value) ? { kind: 'ok', value: result.value } : unavailable('Worker returned an invalid capability');
  }
  async start(spec: WorkerSpec, capability: string): Promise<Result<{ attemptId: string }>> {
    if (!this.validAttempt(spec.attemptId)) return { kind: 'invalid-input', message: 'Invalid attempt reference' };
    const result = await this.call<unknown>('/v1/attempts/start', 'POST', { spec, capability });
    if (result.kind !== 'ok') return result;
    return isObject(result.value) && result.value.attemptId === spec.attemptId ? { kind: 'ok', value: { attemptId: spec.attemptId } } : unavailable('Worker attempt binding mismatch');
  }
  async status(attemptId: string): Promise<Result<{ status: 'queued' | 'running' | 'failed' | 'cancelled' | 'complete'; result?: WorkerResult }>> {
    if (!this.validAttempt(attemptId)) return { kind: 'invalid-input', message: 'Invalid attempt reference' };
    const result = await this.call<unknown>(`/v1/attempts/${attemptId}`, 'GET');
    if (result.kind !== 'ok') return result;
    if (!isObject(result.value)) return unavailable('Worker status unavailable');
    const { status } = result.value;
    if (status === 'complete') { const metadata = resultMetadata(result.value.result, attemptId); return metadata ? { kind: 'ok', value: { status, result: metadata } } : unavailable('Completed worker artifact metadata failed validation'); }
    return status === 'queued' || status === 'running' || status === 'failed' || status === 'cancelled' ? { kind: 'ok', value: { status } } : unavailable('Unknown worker status');
  }
  async cancel(attemptId: string): Promise<Result<void>> {
    if (!this.validAttempt(attemptId)) return { kind: 'invalid-input', message: 'Invalid attempt reference' };
    const result = await this.call<unknown>(`/v1/attempts/${attemptId}/cancel`, 'POST', {});
    return result.kind === 'ok' ? result.value === null ? { kind: 'ok', value: undefined } : unavailable('Worker cancellation was not acknowledged') : result;
  }
  async revoke(attemptId: string): Promise<void> {
    if (!this.validAttempt(attemptId)) throw new Error('Invalid attempt reference');
    const result = await this.call<unknown>(`/v1/attempts/${attemptId}/revoke`, 'POST', {});
    if (result.kind !== 'ok' || result.value !== null) throw new Error('Worker capability revocation unavailable');
  }
  /** Accept only the opaque worker result reference, never a filesystem path or caller URL. */
  async artifactBytes(result: WorkerResult | string): Promise<Uint8Array> {
    const ref = typeof result === 'string' ? result : result.artifactRef;
    const attemptId = ref.startsWith('desk-worker:') ? ref.slice('desk-worker:'.length) : '';
    if (!this.validAttempt(attemptId) || (typeof result !== 'string' && (!hashPattern.test(result.artifactHash) || result.mediaType !== 'text/markdown'))) throw new Error('Invalid worker artifact reference');
    const response = await this.call<unknown>(`/v1/attempts/${attemptId}/artifact`, 'GET');
    if (response.kind !== 'ok' || !isObject(response.value)) throw new Error('Reviewed worker artifact unavailable');
    const metadata = resultMetadata(response.value, attemptId);
    const encoded = response.value.bytesBase64;
    if (!metadata || (typeof result !== 'string' && metadata.artifactHash !== result.artifactHash) || typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Worker artifact binding mismatch');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > this.maxArtifact || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== metadata.artifactHash) throw new Error('Worker artifact bytes failed size or hash verification');
    return bytes;
  }
}
