import { describe, expect, it, vi } from 'vitest';
import { artifactDigest, fixtures, reducePublicState } from '@secondbrain/desk-contracts/desk';
import { DeskOrchestrator } from './service.js';
import { MemoryDeskPersistence } from '../persistence/store.js';

describe('server-authorized Cybazaar release', () => {
  it('publishes reviewed bytes only when the claim provider is the configured signer', async () => {
    const claimObservation = { ref: 'arkiv:test/claim-1', creator: fixtures.claim.provider, observedAt: 130, finalized: true, record: fixtures.claim };
    const bytes = new TextEncoder().encode('# Reviewed response\n');
    const artifactHash = await artifactDigest(bytes);
    const delivery = { ...fixtures.delivery, artifactHash };
    const deliveryObservation = { ref: 'arkiv:test/delivery-1', creator: delivery.provider, observedAt: 140, finalized: true, record: delivery };
    let observations = [...fixtures.success, claimObservation];
    const state = await reducePublicState(observations, fixtures.jobRef, 150);
    const store = new MemoryDeskPersistence();
    await store.seed({ id: fixtures.jobRef, revision: 0, publicState: state, execution: 'review', activeAttemptId: fixtures.claim.executionId, result: { artifactHash, mediaType: delivery.mediaType, artifactRef: 'approved-result', boundedTrace: 'bounded' } });
    const publisher = { mode: 'live' as const, publish: vi.fn(async () => { observations = [...observations, deliveryObservation]; return { kind: 'ok' as const, value: { status: 'confirmed' as const, ref: deliveryObservation.ref } }; }), reconcile: vi.fn() };
    const providerTransactions = { mode: 'live' as const, prepareClaim: vi.fn(), prepareDelivery: vi.fn() };
    const orchestrator = new DeskOrchestrator({
      store, snapshots: { mode: 'live', snapshot: vi.fn(async () => ({ kind: 'ok', value: observations })) },
      publicStore: { mode: 'live', listJobs: vi.fn(), get: vi.fn(), publish: vi.fn(), confirmation: vi.fn() },
      identity: { mode: 'live', profile: vi.fn(), resolve: vi.fn() }, runner: { mode: 'live', start: vi.fn(), status: vi.fn(), cancel: vi.fn() },
      publisher, settlement: { mode: 'live', prepare: vi.fn(), verify: vi.fn(), reconcile: vi.fn() }, providerTransactions,
      capabilities: { mode: 'live', issue: vi.fn(), revoke: vi.fn() }, eligibleProviders: vi.fn(),
      artifactBytes: vi.fn().mockResolvedValue(bytes),
      backendSigner: fixtures.claim.provider,
    });
    const released = await orchestrator.release(fixtures.jobRef, { artifactHash, mediaType: delivery.mediaType, publicDestination: delivery.publicRef, idempotencyKey: 'release-one', expectedRevision: 0 });
    expect(released).toMatchObject({ kind: 'ok', value: { execution: 'released' } });
    expect(publisher.publish).toHaveBeenCalledWith(claimObservation.ref, { artifactHash, mediaType: delivery.mediaType, publicDestination: delivery.publicRef }, 'release-one');
    expect(providerTransactions.prepareDelivery).not.toHaveBeenCalled();
  });
});
