import { describe, expect, it, vi } from 'vitest';
import { fakeIdentity, fakePublicStore, fakePublisher, fakeRunner, fakeSettlement, fixtures, type PaymentIntent } from '@secondbrain/desk-contracts/desk';
import { DeskOrchestrator, type DeskServiceOptions } from './service.js';
import { MemoryDeskPersistence, type AssignmentRecord } from '../persistence/store.js';

describe('payment release gate', () => {
  it('never verifies or reserves a receipt before operator release and verified delivery', async () => {
    const settlement = fakeSettlement(), verify = vi.spyOn(settlement, 'verify');
    const unavailable = async () => ({ kind: 'unavailable' as const, message: 'synthetic test' });
    const options: DeskServiceOptions = { store: new MemoryDeskPersistence(), snapshots: { mode: 'fixture', snapshot: unavailable }, publicStore: fakePublicStore(), identity: fakeIdentity(), runner: fakeRunner(), publisher: fakePublisher(), settlement, providerTransactions: { mode: 'fixture', prepareClaim: unavailable, prepareDelivery: unavailable }, capabilities: { mode: 'fixture', issue: unavailable, revoke: async () => {} }, eligibleProviders: unavailable, artifactBytes: async () => new Uint8Array() };
    const service = new DeskOrchestrator(options);
    const state = { stage: 'accepted' as const, jobRef: fixtures.jobRef, job: fixtures.job, offer: fixtures.offer, acceptanceRef: 'arkiv:test/acceptance-1', conflict: false, rejected: [] };
    for (const row of [{ id: fixtures.jobRef, revision: 0, execution: 'approved', publicState: state }, { id: fixtures.jobRef, revision: 0, execution: 'released', publicState: state }] as AssignmentRecord[]) {
      vi.spyOn(service, 'refresh').mockResolvedValue({ kind: 'ok', value: row });
      expect((await service.reconcilePayment(fixtures.jobRef, '0x' + 'a'.repeat(64))).kind).toBe('denied');
    }
    expect(verify).not.toHaveBeenCalled();
  });
  it('loads payment intent from accepted terms rather than submitted browser fields', async () => {
    const store = new MemoryDeskPersistence(), settlement = fakeSettlement();
    const verify = vi.spyOn(settlement, 'verify').mockResolvedValue({ kind: 'pending', message: 'Waiting on independent chain data' });
    const unavailable = async () => ({ kind: 'unavailable' as const, message: 'synthetic test' });
    const service = new DeskOrchestrator({ store, snapshots: { mode: 'fixture', snapshot: unavailable }, publicStore: fakePublicStore(), identity: fakeIdentity(), runner: fakeRunner(), publisher: fakePublisher(), settlement, providerTransactions: { mode: 'fixture', prepareClaim: unavailable, prepareDelivery: unavailable }, capabilities: { mode: 'fixture', issue: unavailable, revoke: async () => {} }, eligibleProviders: unavailable, artifactBytes: async () => new Uint8Array() });
    vi.spyOn(service, 'refresh').mockResolvedValue({ kind: 'ok', value: { id: fixtures.jobRef, revision: 0, execution: 'released', publicState: { stage: 'delivered', jobRef: fixtures.jobRef, job: fixtures.job, offer: fixtures.offer, acceptanceRef: 'arkiv:test/acceptance-1', delivery: fixtures.delivery, conflict: false, rejected: [] } } });
    expect((await service.reconcilePayment(fixtures.jobRef, '0x' + 'a'.repeat(64))).kind).toBe('pending');
    expect(verify).toHaveBeenCalledWith({ jobRef: fixtures.jobRef, acceptanceRef: 'arkiv:test/acceptance-1', chainId: fixtures.offer.paymentChainId, payer: fixtures.job.client, recipient: fixtures.offer.recipient, asset: fixtures.offer.asset, amountAtomic: fixtures.offer.amountAtomic, transferInterface: fixtures.offer.transferInterface } satisfies PaymentIntent, '0x' + 'a'.repeat(64));
  });
});
