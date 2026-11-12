import { describe, expect, it, vi } from 'vitest';
import { fixtures } from '@secondbrain/desk-contracts/desk';
import type { DeskRecord } from '@secondbrain/desk-contracts/desk';
import { ArkivDeskPublicStore, type ArkivDeskClient, type ArkivPage, type ArkivRow, type ArkivWrite } from '../desk/public-store/arkiv.js';
import { BeeHttpSwarmGateway, ReviewedSwarmPublisher, type PublicationEntry, type PublicationLedger, type SwarmGateway } from '../desk/publishing/swarm.js';
import { artifactDigest } from '@secondbrain/desk-contracts/desk';

const row = (key: string, record: unknown, creator = 'wallet:client'): ArkivRow => ({ key, creator, createdAt: 100, expiresAt: 900, finalized: true, record });
const write = (key: string, record: unknown, confirmed = true): ArkivWrite => ({ key, transactionHash: `0x${key}`, confirmed, record });

describe('P2 Arkiv public store boundary', () => {
  it('uses bounded keyset pages on one finalized snapshot and preserves creator facts', async () => {
    const page = vi.fn<ArkivDeskClient['page']>()
      .mockResolvedValueOnce({ rows: [row('a', fixtures.job)], blockNumber: 12n, finalized: true })
      .mockResolvedValueOnce({ rows: [row('b', fixtures.offer, 'wallet:provider')], blockNumber: 12n, finalized: true })
      .mockResolvedValueOnce({ rows: [], blockNumber: 12n, finalized: true });
    const client: ArkivDeskClient = { page, get: vi.fn(), create: vi.fn(), findByIdempotencyKey: vi.fn(), confirmation: vi.fn() };
    const store = new ArkivDeskPublicStore({ domain: 'example-desk', chainId: 'arkiv:test', client, pageSize: 1, now: () => 150 });
    const result = await store.listJobs();
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.map(item => item.creator)).toEqual(['wallet:client', 'wallet:provider']);
    expect(page.mock.calls.map(call => call[0])).toEqual([
      { afterKey: undefined, limit: 1 },
      { afterKey: 'a', limit: 1, atBlock: 12n },
      { afterKey: 'b', limit: 1, atBlock: 12n },
    ]);
  });

  it('fails closed when finality, pagination snapshot, creator, schema or expiry cannot be trusted', async () => {
    const make = (responses: ArkivPage[]) => new ArkivDeskPublicStore({
      domain: 'example-desk', chainId: 'arkiv:test', pageSize: 1, now: () => 150,
      client: { page: vi.fn().mockImplementation(() => Promise.resolve(responses.shift()!)), get: vi.fn(), create: vi.fn(), findByIdempotencyKey: vi.fn(), confirmation: vi.fn() },
    });
    expect((await make([{ rows: [row('a', fixtures.job)], blockNumber: 1n, finalized: false }]).listJobs()).kind).toBe('unavailable');
    expect((await make([
      { rows: [row('a', fixtures.job)], blockNumber: 1n, finalized: true },
      { rows: [row('b', fixtures.offer)], blockNumber: 2n, finalized: true },
    ]).listJobs()).kind).toBe('unavailable');
    expect((await make([{ rows: [row('a', fixtures.job, '')], blockNumber: 1n, finalized: true }]).listJobs()).kind).toBe('unavailable');
    expect((await make([{ rows: [row('a', { type: 'job' })], blockNumber: 1n, finalized: true }]).listJobs()).kind).toBe('unavailable');
    expect((await make([{ rows: [{ ...row('a', fixtures.job), expiresAt: 150 }], blockNumber: 1n, finalized: true }]).listJobs()).kind).toBe('unavailable');
  });

  it('reconciles record writes by idempotency key and rejects changed payload reuse', async () => {
    const existing = write('record-1', fixtures.job, false);
    const client: ArkivDeskClient = { page: vi.fn(), get: vi.fn(), create: vi.fn(), findByIdempotencyKey: vi.fn().mockResolvedValue(existing), confirmation: vi.fn() };
    const store = new ArkivDeskPublicStore({ domain: 'example-desk', chainId: 'arkiv:test', client });
    const pending = await store.publish(fixtures.job, 'job-submit-1');
    expect(pending).toMatchObject({ kind: 'ok', value: { status: 'pending', ref: 'arkiv:test/record-1' } });
    const changed: DeskRecord = { ...fixtures.job, brief: 'different bytes' };
    expect((await store.publish(changed, 'job-submit-1')).kind).toBe('denied');
    expect(client.create).not.toHaveBeenCalled();
  });
});

describe('P2 reviewed Swarm publisher', () => {
  it('uses Bee postage headers and verifies content-addressed references on the HTTP adapter', async () => {
    const bytes = new TextEncoder().encode('# public result\n');
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ reference: 'b'.repeat(64) }), { status: 201 }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    const bee = new BeeHttpSwarmGateway('https://bee.example.test', 'batch-example', fetcher);
    const ref = await bee.upload(bytes, 'text/markdown; charset=utf-8');
    expect(ref).toBe('b'.repeat(64));
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://bee.example.test/bzz'));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Swarm-Postage-Batch-Id': 'batch-example' } });
    expect([...(fetcher.mock.calls[0]?.[1]?.body as Uint8Array)]).toEqual([...bytes]);
    expect(await bee.download(ref)).toEqual(bytes);
    expect(fetcher.mock.calls[1]?.[0]).toEqual(new URL(`https://bee.example.test/bzz/${ref}`));
    const credentialedBeeUrl = new URL('https://bee.example.test');
    credentialedBeeUrl.username = 'user';
    credentialedBeeUrl.password = 'pass';
    expect(() => new BeeHttpSwarmGateway(credentialedBeeUrl.toString(), 'batch-example')).toThrow();
  });

  it('uploads, reads back exact bytes, publishes one delivery, and reconciles retries', async () => {
    const bytes = new TextEncoder().encode('# Synthetic result\n');
    const hash = await artifactDigest(bytes);
    const binding = { artifactHash: hash, mediaType: 'text/markdown', publicDestination: 'desk-public' };
    let entry: PublicationEntry | null = null;
    const ledger: PublicationLedger = {
      reserve: vi.fn(async input => {
        if (entry && (entry.binding.artifactHash !== input.binding.artifactHash || entry.claimRef !== input.claimRef)) return { kind: 'conflict' };
        if (entry) return { kind: 'existing', entry };
        entry = { ...input, status: 'reserved' };
        return { kind: 'reserved', entry };
      }),
      recordUpload: vi.fn(async (_key, publicRef) => { entry = { ...entry!, publicRef, status: 'uploaded' }; return entry; }),
      recordDelivery: vi.fn(async (_key, deliveryRef) => { entry = { ...entry!, deliveryRef, status: 'delivered' }; return entry; }),
      get: vi.fn(async () => entry),
    };
    const swarm: SwarmGateway = { upload: vi.fn().mockResolvedValue('a'.repeat(64)), download: vi.fn().mockResolvedValue(bytes) };
    const store = {
      mode: 'live' as const,
      publish: vi.fn().mockResolvedValue({ kind: 'ok', value: { status: 'confirmed', ref: 'arkiv:arkiv:test/delivery1' } }),
      confirmation: vi.fn().mockResolvedValue({ kind: 'ok', value: { status: 'confirmed', ref: 'arkiv:arkiv:test/delivery1' } }),
    };
    const publisher = new ReviewedSwarmPublisher({
      swarm, ledger, store, artifacts: { read: vi.fn().mockResolvedValue(bytes) }, claims: { provider: vi.fn().mockResolvedValue('wallet:provider') },
      authorization: { verify: vi.fn().mockResolvedValue(true) }, domain: 'example-desk', chainId: 'arkiv:test', destination: 'desk-public',
    });
    expect(await publisher.publish('arkiv:test/claim1', binding, 'release-1')).toMatchObject({ kind: 'ok', value: { status: 'confirmed' } });
    expect(swarm.upload).toHaveBeenCalledTimes(1);
    expect(swarm.download).toHaveBeenCalledTimes(1);
    expect(store.publish).toHaveBeenCalledTimes(1);
    expect(store.publish.mock.calls[0]?.[0]).toMatchObject({ provider: 'wallet:provider', artifactHash: hash, publicRef: `swarm://${'a'.repeat(64)}` });
    expect(await publisher.publish('arkiv:test/claim1', binding, 'release-1')).toMatchObject({ kind: 'ok', value: { status: 'confirmed' } });
    expect(store.publish).toHaveBeenCalledTimes(1);
  });

  it('rejects changed bytes, unauthorized terms, encrypted refs, and destination drift', async () => {
    const bytes = new TextEncoder().encode('# result\n');
    const binding = { artifactHash: await artifactDigest(bytes), mediaType: 'text/markdown', publicDestination: 'desk-public' };
    const swarm: SwarmGateway = { upload: vi.fn().mockResolvedValue('a'.repeat(64)), download: vi.fn().mockResolvedValue(bytes) };
    const entry: PublicationEntry = { key: 'release-1', claimRef: 'arkiv:test/claim1', binding, status: 'reserved' };
    const ledger: PublicationLedger = { reserve: vi.fn().mockResolvedValue({ kind: 'reserved', entry }), recordUpload: vi.fn().mockResolvedValue({ ...entry, publicRef: 'a'.repeat(64), status: 'uploaded' }), recordDelivery: vi.fn().mockResolvedValue(entry), get: vi.fn().mockResolvedValue(entry) };
    const store = { mode: 'live' as const, publish: vi.fn().mockResolvedValue({ kind: 'ok', value: { status: 'pending', ref: 'arkiv:arkiv:test/d1' } }), confirmation: vi.fn().mockResolvedValue({ kind: 'ok', value: { status: 'pending' } }) };
    const publisher = new ReviewedSwarmPublisher({ swarm, ledger, store, artifacts: { read: vi.fn().mockResolvedValue(bytes) }, claims: { provider: vi.fn().mockResolvedValue('wallet:provider') }, authorization: { verify: vi.fn().mockResolvedValue(false) }, domain: 'example-desk', chainId: 'arkiv:test', destination: 'desk-public' });
    expect((await publisher.publishApprovedBytes({ claimRef: entry.claimRef, binding, idempotencyKey: 'release-1', bytes: new TextEncoder().encode('mutated') })).kind).toBe('denied');
    expect((await publisher.publish(entry.claimRef, binding, 'release-1')).kind).toBe('denied');
    const drift = { ...binding, publicDestination: 'other' };
    expect((await publisher.publish(entry.claimRef, drift, 'release-1')).kind).toBe('invalid-input');
    expect(store.publish).not.toHaveBeenCalled();

    const encrypted = new ReviewedSwarmPublisher({ swarm: { ...swarm, upload: vi.fn().mockResolvedValue('a'.repeat(64) + 'deadbeef') }, ledger, store, artifacts: { read: vi.fn().mockResolvedValue(bytes) }, claims: { provider: vi.fn().mockResolvedValue('wallet:provider') }, authorization: { verify: vi.fn().mockResolvedValue(true) }, domain: 'example-desk', chainId: 'arkiv:test', destination: 'desk-public' });
    expect((await encrypted.publishApprovedBytes({ claimRef: entry.claimRef, binding, idempotencyKey: 'release-2', bytes })).kind).toBe('failed');
  });
});
