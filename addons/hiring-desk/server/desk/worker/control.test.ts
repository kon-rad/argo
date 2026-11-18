import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerResult, WorkerSpec } from '@secondbrain/desk-contracts/desk';
import { TrustedWorkerBridge } from './control.js';
const spec: WorkerSpec = { version: 'desk/v1', jobId: 'job-one', attemptId: 'attempt-one', acceptanceDigest: `sha256:${'a'.repeat(64)}`, skillVersion: 'research/v1', corpusDigest: `sha256:${'b'.repeat(64)}`, inputRefs: ['a', 'b', 'c'], planDigest: `sha256:${'c'.repeat(64)}`, limits: { tools: ['search'], model: 'approved-model', maxCostAtomic: '100', costAsset: 'USD', maxRuntimeSeconds: 60, maxOutputTokens: 100 }, audience: 'gateway', expiresAt: 4102444800 };
const data = Buffer.from('# Public research result\n');
const artifact: WorkerResult = { artifactRef: 'desk-worker:attempt-one', artifactHash: `sha256:${createHash('sha256').update(data).digest('hex')}`, mediaType: 'text/markdown', boundedTrace: 'three supplied documents' };
function transport(values: unknown[]) { const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({ kind: 'ok', value: values.shift() }))); return { fetcher, bridge: new TrustedWorkerBridge({ url: 'https://worker.example', token: 't'.repeat(40), fetch: fetcher as typeof fetch }) }; }
describe('trusted worker control transport', () => {
  it('uses authenticated fixed server-only operations and preserves exact spec', async () => {
    const { bridge, fetcher } = transport(['encoded.signature', { attemptId: 'attempt-one' }, { status: 'running' }, null, null]);
    expect(await bridge.issue(spec)).toEqual({ kind: 'ok', value: 'encoded.signature' });
    expect(await bridge.start(spec, 'encoded.signature')).toEqual({ kind: 'ok', value: { attemptId: 'attempt-one' } });
    expect(await bridge.status('attempt-one')).toEqual({ kind: 'ok', value: { status: 'running' } });
    expect(await bridge.cancel('attempt-one')).toEqual({ kind: 'ok', value: undefined }); await bridge.revoke('attempt-one');
    const calls = fetcher.mock.calls;
    expect(calls.map(([url]) => url)).toEqual(['/v1/capabilities/issue', '/v1/attempts/start', '/v1/attempts/attempt-one', '/v1/attempts/attempt-one/cancel', '/v1/attempts/attempt-one/revoke'].map(p => 'https://worker.example' + p));
    expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({ spec });
    expect(calls.every(([, options]) => options?.redirect === 'error' && (options.headers as Record<string, string>).Authorization === 'Bearer ' + 't'.repeat(40))).toBe(true);
  });
  it('rejects untrusted origins, weak token and invalid transport bounds', () => {
    for (const url of ['http://worker.example', 'https://user:password@worker.example', 'https://worker.example/other', 'https://worker.example?token=secret']) expect(() => new TrustedWorkerBridge({ url, token: 't'.repeat(40) })).toThrow(); // public-ok: synthetic credential URL rejection fixture
    expect(() => new TrustedWorkerBridge({ url: 'https://worker.example', token: 'short' })).toThrow();
    expect(() => new TrustedWorkerBridge({ url: 'http://127.0.0.1:8790', token: 't'.repeat(40) })).not.toThrow();
    expect(() => new TrustedWorkerBridge({ url: 'https://worker.example', token: 't'.repeat(40), maxArtifactBytes: 1000001 })).toThrow();
  });
  it('validates completion result and independently hashes artifact bytes', async () => {
    const { bridge } = transport([{ status: 'complete', result: artifact }, { ...artifact, bytesBase64: data.toString('base64') }, { ...artifact, bytesBase64: data.toString('base64') }]);
    expect(await bridge.status('attempt-one')).toEqual({ kind: 'ok', value: { status: 'complete', result: artifact } });
    expect(Buffer.from(await bridge.artifactBytes(artifact))).toEqual(data);
    expect(Buffer.from(await bridge.artifactBytes(artifact.artifactRef))).toEqual(data);
  });
  it.each(['wrong-hash', 'wrong-ref', 'wrong-media', 'invalid-base64', 'different-bytes'])('rejects artifact response %s', async variant => {
    const response = { ...artifact, bytesBase64: data.toString('base64') };
    if (variant === 'wrong-hash') response.artifactHash = `sha256:${'f'.repeat(64)}`;
    if (variant === 'wrong-ref') response.artifactRef = 'desk-worker:other-attempt';
    if (variant === 'wrong-media') response.mediaType = 'application/octet-stream';
    if (variant === 'invalid-base64') response.bytesBase64 = '@@';
    if (variant === 'different-bytes') response.bytesBase64 = Buffer.from('tampered').toString('base64');
    await expect(transport([response]).bridge.artifactBytes(artifact)).rejects.toThrow();
  });
  it('never accepts caller filesystem paths or URL artifact refs', async () => {
    const { bridge, fetcher } = transport([]);
    for (const ref of ['/etc/passwd', 'https://other.example/result', 'desk-worker:../escape']) await expect(bridge.artifactBytes({ ...artifact, artifactRef: ref })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects arbitrary attempt paths and mismatched start result', async () => {
    const { bridge, fetcher } = transport([{ attemptId: 'other' }]);
    expect((await bridge.status('../escape')).kind).toBe('invalid-input'); expect((await bridge.cancel('../escape')).kind).toBe('invalid-input'); await expect(bridge.revoke('../escape')).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
    expect((await bridge.start(spec, 'capability')).kind).toBe('unavailable');
  });
  it('does not promote invalid worker statuses to complete', async () => {
    for (const value of [{ status: 'complete' }, { status: 'paid' }, { status: 'complete', result: { ...artifact, artifactRef: '/host/private' } }]) expect((await transport([value]).bridge.status('attempt-one')).kind).toBe('unavailable');
  });
  it('fails closed for outage, auth denial, bad JSON and oversized response', async () => {
    for (const fetcher of [vi.fn(async () => { throw new Error('network') }), vi.fn(async () => new Response(JSON.stringify({ kind: 'denied' }), { status: 403 })), vi.fn(async () => new Response('not JSON')), vi.fn(async () => new Response('x'.repeat(1400000)))]) {
      const bridge = new TrustedWorkerBridge({ url: 'https://worker.example', token: 't'.repeat(40), fetch: fetcher as typeof fetch }); expect((await bridge.status('attempt-one')).kind).not.toBe('ok');
    }
  });
  it('requires explicit control acknowledgment for cancellation and revocation', async () => {
    const { bridge } = transport([{ status: 'running' }, { status: 'running' }]);
    expect((await bridge.cancel('attempt-one')).kind).toBe('unavailable');
    await expect(bridge.revoke('attempt-one')).rejects.toThrow();
  });
  it('bounds request and artifact size without filesystem authority', async () => {
    const { bridge, fetcher } = transport([]); expect((await bridge.start({ ...spec, jobId: 'x'.repeat(40000) }, 'capability')).kind).toBe('invalid-input'); expect(fetcher).not.toHaveBeenCalled();
    const tiny = new TrustedWorkerBridge({ url: 'https://worker.example', token: 't'.repeat(40), maxArtifactBytes: 1, fetch: vi.fn(async () => new Response(JSON.stringify({ kind: 'ok', value: { ...artifact, bytesBase64: data.toString('base64') } }))) as typeof fetch }); await expect(tiny.artifactBytes(artifact)).rejects.toThrow();
  });
});
