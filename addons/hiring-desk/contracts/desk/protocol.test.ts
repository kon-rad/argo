import { describe, it, expect } from 'vitest';
import { canonicalJson, digest, parseRecord, reducePublicState, dispatchEligibility, fixtures, fakePublicStore, assertProductionAdapters } from './index.js';

const reduce = (observations = fixtures.success, now = 150) => reducePublicState(observations, fixtures.jobRef, now);

describe('desk/v1 contract', () => {
  it('round trips large atomic amounts and IDs without precision loss', () => {
    const job = parseRecord(JSON.parse(JSON.stringify(fixtures.job)));
    expect(job).toEqual(fixtures.job);
    expect(fixtures.offer.amountAtomic).toBe('900719925474099312345');
    expect(canonicalJson({b: 1, a: 'x'})).toBe('{"a":"x","b":1}');
    expect(() => canonicalJson({a: undefined})).toThrow();
  });
  it('binds all offer terms and separates digest domains', async () => {
    const original = await digest('offer-terms', fixtures.offer);
    expect(await digest('offer-terms', {...fixtures.offer, recipient: 'wallet:other'})).not.toBe(original);
    expect(await digest('acceptance', fixtures.offer)).not.toBe(original);
  });
  it('uses authenticated creators and rejects forged authors', async () => {
    const state = await reduce(fixtures.invalidAuthor);
    expect(state.stage).toBe('offered');
    expect(state.rejected.some(x => x.code === 'AUTHOR_MISMATCH')).toBe(true);
  });
  it('blocks conflicting acceptances regardless of observation order', async () => {
    const a = await reduce(fixtures.conflictingAcceptance);
    const b = await reduce([...fixtures.conflictingAcceptance].reverse());
    expect(a.stage).toBe('offered');
    expect(a.conflict).toBe(true);
    expect(a).toEqual(b);
    expect(dispatchEligibility(a, fixtures.dispatchContext).ok).toBe(false);
  });
  it('rejects replay, expiration, and mismatched chain domains', async () => {
    for (const observations of [fixtures.replay, fixtures.expiredOffer, fixtures.wrongChain]) {
      const state = await reduce(observations);
      expect(state.stage).toBe('offered');
      expect(dispatchEligibility(state, fixtures.dispatchContext).ok).toBe(false);
    }
    expect(dispatchEligibility(await reduce(), {...fixtures.dispatchContext, now: 1001}).ok).toBe(false);
  });
  it('does not turn a worker result or unverified payment into public delivery or payment', async () => {
    const state = await reduce();
    expect(state.stage).toBe('accepted');
    expect(dispatchEligibility(state, fixtures.dispatchContext).ok).toBe(true);
    expect(dispatchEligibility(state, {...fixtures.dispatchContext, activeAttempt: true}).ok).toBe(false);
    expect(dispatchEligibility(state, {...fixtures.dispatchContext, cancelled: true}).ok).toBe(false);
    expect((await reduce(fixtures.unverifiedPayment)).stage).not.toBe('paid');
  });
  it('rejects changed release artifacts, noncanonical amounts and malformed data', () => {
    expect(fixtures.changedArtifact.approval.artifactHash).not.toBe(fixtures.changedArtifact.request.artifactHash);
    expect(() => parseRecord({...fixtures.offer, amountAtomic: '01'})).toThrow();
    expect(() => parseRecord({...fixtures.offer, extra: true})).toThrow();
    expect(() => parseRecord({...fixtures.offer, amountAtomic: 2})).toThrow();
  });
  it('exposes unavailable failures and refuses test adapters in production', async () => {
    const store = fakePublicStore({kind: 'unavailable', message: 'offline'});
    expect((await store.listJobs()).kind).toBe('unavailable');
    expect(() => assertProductionAdapters('production', [store])).toThrow();
  });
});

describe('security and lifecycle boundaries', () => {
  it('requires exact, independently verified payment evidence after delivery', async () => {
    const { digest } = await import('./index.js');
    const evidenceRef = 'arkiv:test/payment-1';
    expect((await reduce(fixtures.unverifiedPayment)).stage).toBe('delivered');
    const evidenceDigest = await digest('payment-evidence', fixtures.payment);
    const verified = {evidenceRef, evidenceDigest, receiptId:'arc:test/tx-example/0', verified:true as const};
    expect((await reducePublicState(fixtures.unverifiedPayment, fixtures.jobRef, 150, [verified])).stage).toBe('paid');
    expect((await reducePublicState(fixtures.unverifiedPayment, fixtures.jobRef, 150, [{...verified,evidenceDigest:'sha256:'+'0'.repeat(64)}])).stage).toBe('delivered');
  });
  it('rejects malformed and unfinalized records and de-duplicates identical observations', async () => {
    const duplicate = [...fixtures.success, fixtures.success[2]];
    expect((await reduce(duplicate)).stage).toBe('accepted');
    const bad = [...fixtures.success.slice(0,2), {...fixtures.success[2],finalized:false}];
    expect((await reduce(bad)).stage).toBe('offered');
    const equivocation = [...fixtures.success, {...fixtures.success[2],creator:'wallet:other'}];
    expect((await reduce(equivocation)).conflict).toBe(true);
    expect(dispatchEligibility(await reduce(equivocation),fixtures.dispatchContext).ok).toBe(false);
    expect((await reduce([])).stage).toBe('unknown');
  });
  it('does not dispatch after a late conflicting acceptance', async () => {
    const late = [...fixtures.conflictingAcceptance, {ref:'arkiv:test/claim-1',creator:fixtures.offer.provider,observedAt:125,finalized:true,record:fixtures.claim}];
    const result = await reduce(late);
    expect(result.conflict).toBe(true);
    expect(dispatchEligibility(result,fixtures.dispatchContext).ok).toBe(false);
  });
  it('rejects encrypted key-bearing swarm references', () => {
    expect(() => parseRecord({...fixtures.delivery,publicRef:'swarm://'+'b'.repeat(128)})).toThrow();
  });
  it('binds worker capabilities and release to exactly approved values', async () => {
    const {checkWorkerSpec,checkRelease} = await import('./index.js');
    const hash = 'sha256:'+'a'.repeat(64);
    const limits = {tools:['search'],model:'example',maxCostAtomic:'5',costAsset:'USD',maxRuntimeSeconds:30,maxOutputTokens:100};
    const approval = {idempotencyKey:'key',expectedRevision:1,acceptanceDigest:hash,skillVersion:'v1',corpusDigest:hash,inputRefs:['doc-1'],audience:'gateway',expiresAt:200,limits,planDigest:hash};
    const spec = {version:'desk/v1' as const,jobId:'job',attemptId:'attempt',acceptanceDigest:hash,skillVersion:'v1',corpusDigest:hash,inputRefs:['doc-1'],planDigest:hash,limits,audience:'gateway',expiresAt:190};
    const expected = {jobId:'job',attemptId:'attempt',audience:'gateway',now:150,maxLifetimeSeconds:60};
    expect(checkWorkerSpec(spec,approval,expected)).toBe(true);
    expect(checkWorkerSpec({...spec,inputRefs:['different']},approval,expected)).toBe(false);
    expect(checkWorkerSpec({...spec,limits:{...limits,maxCostAtomic:'6'}},approval,expected)).toBe(false);
    expect(checkWorkerSpec({...spec,expiresAt:201},approval,expected)).toBe(false);
    expect(checkWorkerSpec(spec,approval,{...expected,maxLifetimeSeconds:10})).toBe(false);
    expect(checkWorkerSpec(spec,approval,{...expected,now:190})).toBe(false);
    const release = {...fixtures.changedArtifact.approval,idempotencyKey:'release',expectedRevision:2};
    expect(checkRelease(fixtures.changedArtifact.approval,release,2)).toBe(true);
    expect(checkRelease(fixtures.changedArtifact.approval,{...release,...fixtures.changedArtifact.request},2)).toBe(false);
    expect(checkRelease(fixtures.changedArtifact.approval,release,3)).toBe(false);
  });
});

it('exposes successful synthetic reads without pretending fixture publication succeeded', async () => {
  const {fakeSnapshotStore} = await import('./index.js');
  const store = fakeSnapshotStore();
  expect(await store.listJobs()).toEqual({kind:'ok',value:[fixtures.success[0]]});
  expect((await store.get(fixtures.jobRef)).kind).toBe('ok');
  expect((await store.publish(fixtures.job,'example-key')).kind).toBe('denied');
  expect((await store.confirmation('example')).kind).toBe('pending');
});
