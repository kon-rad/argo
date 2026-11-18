import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { artifactDigest, digest, fixtures, reducePublicState, type Observation, type ProviderWalletIntent } from '@secondbrain/desk-contracts/desk';
import { DeskOrchestrator, type DeskServiceOptions } from './service.js';
import { MemoryDeskPersistence } from '../persistence/store.js';
import { deskOperatorRouter } from '../operator/routes.js';
const owner = `0x${'1'.repeat(40)}`, client = `0x${'2'.repeat(40)}`, contract = `0x${'3'.repeat(40)}`, txHash = `0x${'a'.repeat(64)}`;
async function setup() {
  const job = { ...fixtures.job, client }, offer = { ...fixtures.offer, provider: owner, recipient: owner };
  const acceptance = { ...fixtures.acceptance, client, offerDigest: await digest('offer-terms', offer) };
  let observations: Observation[] = fixtures.success.map(o => ({ ...o, creator: (o.record as {type:string}).type === 'offer' ? owner : client, record: (o.record as {type:string}).type === 'job' ? job : (o.record as {type:string}).type === 'offer' ? offer : acceptance }));
  const store = new MemoryDeskPersistence(); const bytes = new TextEncoder().encode('# Public synthetic result');
  const artifactHash = await artifactDigest(bytes);
  const provider = { version: 'desk/v1', type: 'provider', domain: job.domain, chainId: job.chainId, providerId: offer.providerId, profileRef: 'profile', owner, skill: job.skill, skillVersion: offer.skillVersion, identityRefs: [], paymentAddress: owner };
  const start = vi.fn(async () => ({ kind: 'ok', value: { attemptId: (await store.get(fixtures.jobRef))!.activeAttemptId! } }));
  const o = {
    store, now: () => 150,
    snapshots: { mode: 'fixture', snapshot: async () => ({ kind: 'ok', value: observations }) },
    publicStore: { mode: 'fixture' }, identity: { mode: 'fixture', resolve: async () => ({ kind: 'ok', value: { verified: true, provider } }) },
    runner: { mode: 'fixture', start, cancel: async () => ({ kind: 'ok', value: undefined }) },
    publisher: { mode: 'fixture' }, settlement: { mode: 'fixture' },
    providerTransactions: { mode: 'fixture', prepareClaim: vi.fn(async () => ({ kind: 'ok', value: { chainId: '1', transaction: { to: contract, data: '0x12345678' } } })), prepareDelivery: vi.fn(async () => ({ kind: 'ok', value: { chainId: '1', transaction: { to: contract, data: '0xaabbccdd' } } })) },
    capabilities: { mode: 'fixture', issue: async () => ({ kind: 'ok', value: 'capability' }), revoke: async () => {} },
    eligibleProviders: async () => ({ kind: 'ok', value: [provider] }), artifactBytes: async () => bytes,
  } as unknown as DeskServiceOptions;
  const state = await reducePublicState(observations, fixtures.jobRef, 150);
  await store.seed({ id: fixtures.jobRef, revision: 0, publicState: state, execution: 'approved', approval: { acceptanceDigest: state.acceptanceDigest!, idempotencyKey: 'approval', expectedRevision: 0, skillVersion: offer.skillVersion, corpusDigest: `sha256:${'b'.repeat(64)}`, inputRefs: ['public-document'], audience: 'desk-worker', expiresAt: 700, limits: { tools: [], model: 'test-model', maxCostAtomic: '5', costAsset: 'USDC', maxRuntimeSeconds: 60, maxOutputTokens: 100 }, planDigest: `sha256:${'c'.repeat(64)}` } });
  const service = new DeskOrchestrator(o);
  return { service, o, store, start, artifactHash, add(record: unknown, creator = owner, finalized = true) { observations.push({ ref: `arkiv:test/${(record as {type:string}).type}-1`, creator, finalized, observedAt: 140, record }); }, async review() {
    const row = (await store.get(fixtures.jobRef))!;
    const claim = { ...fixtures.claim, provider: owner, executionId: row.activeAttemptId! };
    observations.push({ ref: 'arkiv:test/claim-1', creator: owner, finalized: true, observedAt: 130, record: claim });
    const publicState = await reducePublicState(observations, fixtures.jobRef, 150);
    await store.seed({ ...row, execution: 'review', publicState, result: { artifactHash, mediaType: 'text/markdown', artifactRef: 'public-artifact', boundedTrace: 'synthetic' } });
  } };
}
const claimRequest = { expectedRevision: 0, idempotencyKey: 'prepare-claim' };
async function claim(f: Awaited<ReturnType<typeof setup>>): Promise<ProviderWalletIntent> {
  const result = await f.service.prepareClaim(fixtures.jobRef, claimRequest); expect(result.kind).toBe('ok'); if (result.kind !== 'ok') throw new Error(result.message); return result.value;
}
describe('durable provider wallet orchestration', () => {
  it('reserves one attempt, stores immutable intent, and resumes after service restart', async () => {
    const f = await setup(); const intent = await claim(f);
    expect(intent).toMatchObject({ action: 'claim', requiredCreator: owner, chainId: '0x1', jobRef: fixtures.jobRef });
    expect((await f.store.get(fixtures.jobRef))?.execution).toBe('queued'); expect(f.start).not.toHaveBeenCalled();
    const restarted = new DeskOrchestrator(f.o);
    expect(await restarted.walletIntent(fixtures.jobRef, 'claim')).toEqual({ kind: 'ok', value: intent });
    expect(await restarted.prepareClaim(fixtures.jobRef, claimRequest)).toEqual({ kind: 'ok', value: intent });
  });
  it('a hash records pending only and conflicting hashes or intent references fail', async () => {
    const f = await setup(); const intent = await claim(f);
    expect(await f.service.submitWallet(fixtures.jobRef, 'claim', { intentRef: intent.intentRef, txHash })).toEqual({ kind: 'ok', value: { status: 'pending', txHash } });
    expect((await f.service.submitWallet(fixtures.jobRef, 'claim', { intentRef: intent.intentRef, txHash })).kind).toBe('ok');
    expect((await f.service.submitWallet(fixtures.jobRef, 'claim', { intentRef: intent.intentRef, txHash: `0x${'b'.repeat(64)}` })).kind).toBe('denied');
    expect((await f.service.submitWallet(fixtures.jobRef, 'claim', { intentRef: 'other', txHash })).kind).toBe('denied');
    expect((await f.service.reconcileWallet(fixtures.jobRef, 'claim')).kind).toBe('pending'); expect(f.start).not.toHaveBeenCalled();
  });
  it('concurrent prepare reserves one attempt and stale submit never changes the binding', async () => {
    const f = await setup(); const results = await Promise.all([f.service.prepareClaim(fixtures.jobRef, claimRequest), f.service.prepareClaim(fixtures.jobRef, claimRequest)]);
    const intents = results.filter(r => r.kind === 'ok').map(r => r.kind === 'ok' ? r.value : null);
    expect(intents.length).toBeGreaterThan(0); expect(new Set(intents.map(i => i!.intentRef)).size).toBe(1);
    expect((await f.store.get(fixtures.jobRef))?.activeAttemptId).toBe(intents[0]!.executionId);
  });
  it('concurrent conflicting submissions acknowledge only the stored transaction', async () => {
    const f = await setup(); const intent = await claim(f);
    const hashes = [txHash, `0x${'c'.repeat(64)}`];
    const results = await Promise.all(hashes.map(txHash => f.service.submitWallet(fixtures.jobRef, 'claim', { intentRef: intent.intentRef, txHash })));
    expect(results.filter(r => r.kind === 'ok')).toHaveLength(1);
    expect(results.filter(r => r.kind === 'denied')).toHaveLength(1);
    const stored = (await f.store.get(fixtures.jobRef))!.walletIntents!.claim!.txHash;
    expect(results.find(r => r.kind === 'ok')).toEqual({ kind: 'ok', value: { status: 'pending', txHash: stored } });
  });
  it('wrong or nonfinal claim cannot start worker; exact finalized claim can', async () => {
    for (const invalid of ['creator','execution','finality']) {
      const f = await setup(); const intent = await claim(f);
      f.add({ ...fixtures.claim, provider: owner, executionId: invalid === 'execution' ? 'other' : intent.executionId }, invalid === 'creator' ? client : owner, invalid !== 'finality');
      expect((await f.service.reconcileWallet(fixtures.jobRef, 'claim')).kind).toBe('pending'); expect(f.start).not.toHaveBeenCalled();
    }
    const f = await setup(); const intent = await claim(f); f.add({ ...fixtures.claim, provider: owner, executionId: intent.executionId });
    expect((await f.service.reconcileWallet(fixtures.jobRef, 'claim')).kind).toBe('ok'); expect(f.start).toHaveBeenCalledTimes(1);
    const app = express(); app.use(express.json()); app.use('/api/desk', deskOperatorRouter(f.service, (_req, _res, next) => next()));
    expect((await request(app).post(`/api/desk/jobs/${encodeURIComponent(fixtures.jobRef)}/claim/reconcile`).send({})).status).toBe(200);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
  it('rejects changed terms, cancellation and expiration before submit', async () => {
    for (const invalid of ['cancelled', 'expired']) {
      const f = await setup(); const intent = await claim(f); const row = (await f.store.get(fixtures.jobRef))!;
      if (invalid === 'cancelled') row.execution = 'cancelled'; else row.walletIntents!.claim!.intent.expiresAt = 150;
      await f.store.seed(row);
      expect((await f.service.submitWallet(fixtures.jobRef, 'claim', { intentRef: intent.intentRef, txHash })).kind).toBe('denied');
    }
  });
  it('release stays private until exact approved provider-authored delivery is finalized', async () => {
    const f = await setup(); await claim(f); await f.review();
    const row = (await f.store.get(fixtures.jobRef))!;
    const result = await f.service.prepareDelivery(fixtures.jobRef, { expectedRevision: row.revision, idempotencyKey: 'release-1', artifactHash: f.artifactHash, mediaType: 'text/markdown', publicDestination: `swarm://${'b'.repeat(64)}` });
    expect(result.kind).toBe('ok'); if (result.kind !== 'ok') throw new Error(result.message);
    expect((await f.store.get(fixtures.jobRef))?.execution).toBe('review');
    expect((await f.service.reconcileWallet(fixtures.jobRef, 'delivery')).kind).toBe('pending');
    f.add({ ...fixtures.delivery, provider: owner, artifactHash: f.artifactHash, publicRef: `swarm://${'b'.repeat(64)}` });
    expect((await f.service.reconcileWallet(fixtures.jobRef, 'delivery')).kind).toBe('ok');
    expect((await f.store.get(fixtures.jobRef))?.execution).toBe('released');
  });
  it('adapter missing an unsigned EVM transaction fails visibly without starting the worker', async () => {
    const f = await setup(); vi.mocked(f.o.providerTransactions.prepareClaim).mockResolvedValue({ kind: 'ok', value: { chainId: '1', transaction: {} } });
    expect((await f.service.prepareClaim(fixtures.jobRef, claimRequest)).kind).toBe('unavailable'); expect(f.start).not.toHaveBeenCalled();
  });
});
describe('provider route privacy boundary', () => {
  it('gates prepare, resume, submit and reconcile and rejects extra authoritative terms', async () => {
    const f = await setup(); const app = express(); app.use(express.json()); app.use('/api/desk', deskOperatorRouter(f.service, (req,res,next) => req.headers.authorization ? next() : res.sendStatus(401)));
    const root = `/api/desk/jobs/${encodeURIComponent(fixtures.jobRef)}`;
    for (const path of ['claim/prepare','claim/submit','claim/reconcile','release/prepare','release/submit','release/reconcile']) expect((await request(app).post(`${root}/${path}`).send({})).status).toBe(401);
    expect((await request(app).get(`${root}/claim/intent`)).status).toBe(401);
    expect((await request(app).post(`${root}/claim/prepare`).set('Authorization','session').send({ ...claimRequest, requiredCreator: client })).status).toBe(400);
    expect((await request(app).post(`${root}/claim/prepare`).set('Authorization','session').send(claimRequest)).status).toBe(200);
  });
});
