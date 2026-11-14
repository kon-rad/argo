import { validateWalletIntent, walletTransaction, walletHash, type ProviderWalletIntent, type WalletSubmission } from '@secondbrain/desk-contracts/desk';
import { randomUUID } from 'node:crypto';
import { artifactDigest, assertProductionAdapters, checkMutation, checkRelease, checkWorkerSpec, dispatchEligibility, parseRecord, reducePublicState, type Adapter, type Approval, type Claim, type Confirmation, type DeskIdentity, type DeskOperatorApi, type DeskPublicStore, type DeskPublisher, type DeskRecord, type DeskRunner, type DeskSettlement, type EntityRef, type Mutation, type Observation, type OperatorJob, type Provider, type PublicState, type ReleaseRequest, type Result, type WorkerResult, type WorkerSpec } from '@secondbrain/desk-contracts/desk';
import { DeskStoreError, type AssignmentRecord, type DeskPersistence } from '../persistence/store.js';

export interface DeskSnapshots extends Adapter { snapshot(jobRef: EntityRef): Promise<Result<Observation[]>> }
/** Provider wallet transaction preparation must return unsigned data for the configured provider to sign. */
export interface ProviderTransactionIntents extends Adapter {
  prepareClaim(input: { acceptanceRef: EntityRef; provider: string; executionId: string; idempotencyKey: string }): Promise<Result<{ chainId: string; transaction: unknown }>>;
  prepareDelivery(input: { claimRef: EntityRef; provider: string; artifactHash: string; mediaType: string; publicDestination: string; idempotencyKey: string }): Promise<Result<{ chainId: string; transaction: unknown }>>;
}
export interface CapabilityIssuer extends Adapter { issue(spec: WorkerSpec): Promise<Result<string>>; revoke(attemptId: string): Promise<void> }
export interface DeskServiceOptions {
  store: DeskPersistence;
  snapshots: DeskSnapshots;
  publicStore: DeskPublicStore;
  identity: DeskIdentity;
  runner: DeskRunner;
  publisher: DeskPublisher;
  settlement: DeskSettlement;
  providerTransactions: ProviderTransactionIntents;
  capabilities: CapabilityIssuer;
  eligibleProviders(): Promise<Result<Provider[]>>;
  now?: () => number;
  /** Exact artifact bytes are loaded by a trusted artifact store, never supplied by an operator request. */
  artifactBytes(ref: string): Promise<Uint8Array>;
  /** Server may publish only records whose frozen creator field is this address. */
  backendSigner?: string;
}

const err = (kind: 'invalid-input' | 'denied' | 'pending' | 'unavailable' | 'failed', message: string): Result<never> => ({ kind, message });
const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });
const timestamp = (o: DeskServiceOptions) => (o.now ?? (() => Math.floor(Date.now() / 1000)))();
function asJob(row: AssignmentRecord): OperatorJob { return { id: row.id, revision: row.revision, publicState: row.publicState, execution: row.execution, ...(row.approval ? { approval: row.approval } : {}), ...(row.result ? { result: row.result } : {}) }; }

export class DeskOrchestrator implements DeskOperatorApi {
  readonly mode: 'live' | 'fixture';
  constructor(private readonly o: DeskServiceOptions) {
    const adapters = [o.snapshots, o.publicStore, o.identity, o.runner, o.publisher, o.settlement, o.providerTransactions, o.capabilities];
    assertProductionAdapters(process.env.NODE_ENV ?? 'development', adapters);
    this.mode = adapters.every(a => a.mode === 'live') ? 'live' : 'fixture';
  }
  async inbox(): Promise<Result<OperatorJob[]>> { const r = await this.jobs(); return r.kind === 'ok' ? ok(r.value.filter(j => j.execution === 'awaiting_operator' && Boolean(j.publicState.acceptance))) : r; }
  async jobs(): Promise<Result<OperatorJob[]>> {
    const publicJobs = await this.o.publicStore.listJobs(); if (publicJobs.kind !== 'ok') return publicJobs;
    for (const observation of publicJobs.value) {
      if ((observation.record as { type?: string }).type !== 'job') return err('failed', 'Public job listing included a non-job record');
      const refreshed = await this.refresh(observation.ref); if (refreshed.kind !== 'ok') return refreshed;
    }
    try { return ok((await this.o.store.list()).map(asJob)); } catch { return err('unavailable', 'Desk persistence unavailable'); }
  }
  async job(id: string): Promise<Result<OperatorJob>> {
    const row = await this.refresh(id); return row.kind === 'ok' ? ok(asJob(row.value)) : row;
  }
  async providers(): Promise<Result<Provider[]>> {
    const configured = await this.o.eligibleProviders(); if (configured.kind !== 'ok') return configured;
    const verified: Provider[] = [];
    for (const candidate of configured.value) {
      const binding = await this.o.identity.resolve(candidate.providerId);
      if (binding.kind !== 'ok') return binding;
      if (binding.value.verified && binding.value.provider.owner === candidate.owner && binding.value.provider.skill === candidate.skill && binding.value.provider.skillVersion === candidate.skillVersion && binding.value.provider.paymentAddress === candidate.paymentAddress) verified.push(binding.value.provider);
    }
    return ok(verified);
  }

  /** Session-gated publication for signer-owned request and negotiation records. */
  async publishRecord(input: unknown, idempotencyKey: string): Promise<Result<Confirmation>> {
    let record: DeskRecord;
    try { record = parseRecord(input); } catch { return err('invalid-input', 'Invalid desk/v1 publication record'); }
    if (!this.o.backendSigner || (record.type !== 'job' && record.type !== 'offer' && record.type !== 'acceptance') || !idempotencyKey || idempotencyKey.length > 200) return err('denied', 'Backend publication is not authorized for this record');
    const creator = record.type === 'offer' ? record.provider : record.client;
    if (creator.toLowerCase() !== this.o.backendSigner.toLowerCase()) return err('denied', 'Backend signer does not match the frozen record authority');
    return this.o.publicStore.publish(record, idempotencyKey);
  }

  /** Refreshes the full verified public snapshot before any decision; failed reads never become an empty state. */
  async refresh(jobRef: EntityRef): Promise<Result<AssignmentRecord>> {
    const observed = await this.o.snapshots.snapshot(jobRef); if (observed.kind !== 'ok') return observed;
    const state = await reducePublicState(observed.value, jobRef, timestamp(this.o));
    if (!state.job || state.conflict) return err(state.conflict ? 'denied' : 'unavailable', state.conflict ? 'Public records conflict' : 'Job is not established by a verified public snapshot');
    const existing = await this.o.store.get(jobRef);
    if (existing) {
      if (existing.publicState.acceptanceDigest && state.acceptanceDigest && existing.publicState.acceptanceDigest !== state.acceptanceDigest) return err('denied', 'Accepted terms changed after approval');
      try { return ok(await this.o.store.updatePublicState(jobRef, state)); } catch (e) { return this.storeError(e); }
    }
    const initial: AssignmentRecord = { id: jobRef, revision: 0, publicState: state, execution: 'awaiting_operator' };
    await this.o.store.seed(initial);
    return ok(initial);
  }

  async approve(id: string, request: Approval): Promise<Result<OperatorJob>> {
    const synced = await this.refresh(id); if (synced.kind !== 'ok') return synced;
    const state = synced.value.publicState;
    if (!checkMutation(request, synced.value.revision) || !state.acceptance || !state.acceptanceDigest || request.acceptanceDigest !== state.acceptanceDigest) return err('invalid-input', 'Approval revision or acceptance digest is invalid');
    if (request.skillVersion !== state.offer?.skillVersion || timestamp(this.o) >= request.expiresAt) return err('denied', 'Approval skill or expiry does not match accepted offer');
    try {
      const { record } = await this.o.store.mutate(id, { action: 'approve', idempotencyKey: request.idempotencyKey, expectedRevision: request.expectedRevision, actor: 'operator', apply: current => {
        if (current.execution !== 'awaiting_operator') throw new DeskStoreError('invalid-state');
        current.approval = structuredClone(request); current.execution = 'approved'; return current;
      } });
      return ok(asJob(record));
    } catch (e) { return this.storeError(e); }
  }

  async decline(id: string, request: Mutation): Promise<Result<OperatorJob>> { return this.change(id, 'decline', request, r => { if (r.execution !== 'awaiting_operator' && r.execution !== 'approved') throw new DeskStoreError('invalid-state'); r.execution = 'cancelled'; return r; }); }
  async cancel(id: string, request: Mutation): Promise<Result<OperatorJob>> {
    const current = await this.ensure(id); if (current.kind !== 'ok') return current;
    const attempt = current.value.activeAttemptId;
    const changed = await this.change(id, 'cancel', request, r => { if (['released','failed','cancelled'].includes(r.execution)) throw new DeskStoreError('invalid-state'); r.execution = 'cancelled'; return r; });
    if (changed.kind === 'ok' && attempt) { await this.o.capabilities.revoke(attempt); const stop = await this.o.runner.cancel(attempt); if (stop.kind !== 'ok' && stop.kind !== 'pending') return stop as Result<never>; }
    return changed;
  }
  async preview(id: string): Promise<Result<WorkerResult>> { const row = await this.ensure(id); return row.kind === 'ok' && row.value.result ? ok(row.value.result) : err('unavailable', 'No worker result is ready for review'); }

  /** Approval reserves one immutable attempt before external calls. Claim transaction is unsigned and provider-authored. */
  async dispatch(id: string, request: Mutation, corpusDigest: string, inputRefs: readonly string[], planDigest: string, limits: Approval['limits'], audience: string): Promise<Result<{ attemptId: string; claimTransaction: unknown }>> {
    const synced = await this.refresh(id); if (synced.kind !== 'ok') return synced;
    const row = synced.value, state = row.publicState, approval = row.approval;
    if (row.execution === 'queued' && row.activeAttemptId && row.workerSpec && row.dispatchIdempotencyKey === request.idempotencyKey) {
      if (this.o.backendSigner && this.o.backendSigner.toLowerCase() === state.offer?.provider.toLowerCase()) {
        const claim: Claim = { version: 'desk/v1', domain: state.offer.domain, chainId: state.offer.chainId, type: 'claim', acceptanceRef: state.acceptanceRef!, provider: state.offer.provider, executionId: row.activeAttemptId };
        const published = await this.o.publicStore.publish(claim, `desk-claim:${request.idempotencyKey}`);
        return published.kind === 'ok' ? ok({ attemptId: row.activeAttemptId, claimTransaction: null }) : published as Result<never>;
      }
      const retryIntent = await this.o.providerTransactions.prepareClaim({ acceptanceRef: state.acceptanceRef!, provider: state.offer!.provider, executionId: row.activeAttemptId, idempotencyKey: request.idempotencyKey });
      return retryIntent.kind === 'ok' ? ok({ attemptId: row.activeAttemptId, claimTransaction: retryIntent.value.transaction }) : retryIntent as Result<never>;
    }
    if (!approval || row.execution !== 'approved' || !checkMutation(request, row.revision)) return err('denied', 'Job is not approved at the expected revision');
    const eligible = await this.providers(); if (eligible.kind !== 'ok') return eligible;
    const allowed = dispatchEligibility(state, { now: timestamp(this.o), approvedAcceptanceDigest: approval.acceptanceDigest, approvedSkillVersion: approval.skillVersion, eligibleProviders: eligible.value.map(p => ({ providerId: p.providerId, owner: p.owner, skill: p.skill, skillVersion: p.skillVersion })), activeAttempt: Boolean(row.activeAttemptId), cancelled: false });
    if (!allowed.ok) return err('denied', `Dispatch is not eligible: ${allowed.code}`);
    const attemptId = randomUUID();
    const spec: WorkerSpec = { version: 'desk/v1', jobId: id, attemptId, acceptanceDigest: approval.acceptanceDigest, skillVersion: approval.skillVersion, corpusDigest, inputRefs, planDigest, limits, audience, expiresAt: Math.min(approval.expiresAt, timestamp(this.o) + 900) };
    if (!checkWorkerSpec(spec, approval, { jobId: id, attemptId, audience, now: timestamp(this.o), maxLifetimeSeconds: 900 })) return err('invalid-input', 'Worker specification differs from the approved execution plan');
    let reserved: AssignmentRecord;
    try { reserved = (await this.o.store.mutate(id, { action: 'dispatch', idempotencyKey: request.idempotencyKey, expectedRevision: request.expectedRevision, actor: 'operator', apply: r => { if (r.execution !== 'approved' || r.activeAttemptId) throw new DeskStoreError('conflict'); r.activeAttemptId = attemptId; r.dispatchIdempotencyKey = request.idempotencyKey; r.workerSpec = spec; r.execution = 'queued'; return r; } })).record; }
    catch (e) { return this.storeError(e); }
    const reservedAttempt = reserved.activeAttemptId;
    if (!reservedAttempt || !reserved.workerSpec) return err('unavailable', 'Attempt reservation is incomplete');
    if (this.o.backendSigner && this.o.backendSigner.toLowerCase() === state.offer!.provider.toLowerCase()) {
      const claim: Claim = { version: 'desk/v1', domain: state.offer!.domain, chainId: state.offer!.chainId, type: 'claim', acceptanceRef: state.acceptanceRef!, provider: state.offer!.provider, executionId: reservedAttempt };
      const published = await this.o.publicStore.publish(claim, `desk-claim:${request.idempotencyKey}`);
      return published.kind === 'ok' ? ok({ attemptId: reservedAttempt, claimTransaction: null }) : published as Result<never>;
    }
    const claim = await this.o.providerTransactions.prepareClaim({ acceptanceRef: state.acceptanceRef!, provider: state.offer!.provider, executionId: reservedAttempt, idempotencyKey: request.idempotencyKey });
    if (claim.kind !== 'ok') return claim as Result<never>;
    return ok({ attemptId: reservedAttempt, claimTransaction: claim.value.transaction });
  }

  /** Provider wallet callback: only the verified public snapshot can authorize launch; callback body is ignored. */
  async reconcileClaim(id: string): Promise<Result<OperatorJob>> {
    const row = await this.ensure(id); if (row.kind !== 'ok') return row;
    if (!row.value.activeAttemptId || row.value.execution !== 'queued' || !row.value.approval) return err('denied', 'No queued attempt is waiting for its provider claim');
    const snap = await this.o.snapshots.snapshot(id); if (snap.kind !== 'ok') return snap;
    const state = await reducePublicState(snap.value, id, timestamp(this.o));
    const claimObservation = snap.value.find(o => (o.record as { type?: string; executionId?: string }).type === 'claim' && (o.record as { executionId?: string }).executionId === row.value.activeAttemptId);
    if (!state.claim || state.claim.executionId !== row.value.activeAttemptId || state.claim.provider !== state.offer?.provider || !claimObservation || claimObservation.creator !== state.offer?.provider) return err('pending', 'Provider-authored claim is not yet finalized');
    const spec = row.value.workerSpec;
    if (!spec) return err('unavailable', 'Reserved immutable worker specification is missing');
    const capability = await this.o.capabilities.issue(spec); if (capability.kind !== 'ok') return capability as Result<never>;
    const started = await this.o.runner.start(spec, capability.value); if (started.kind !== 'ok') return started as Result<never>;
    try { const saved = await this.o.store.mutate(id, { action: 'runner-started', idempotencyKey: `runner:${row.value.activeAttemptId}`, expectedRevision: row.value.revision, actor: 'runner', apply: r => { if (r.execution !== 'queued' || r.activeAttemptId !== started.value.attemptId) throw new DeskStoreError('conflict'); r.execution = 'running'; r.publicState = state; return r; } }); return ok(asJob(saved.record)); }
    catch (e) { await this.o.runner.cancel(row.value.activeAttemptId); await this.o.capabilities.revoke(row.value.activeAttemptId); return this.storeError(e); }
  }

  async reconcileRunner(id: string): Promise<Result<OperatorJob>> {
    const row = await this.ensure(id); if (row.kind !== 'ok') return row;
    const attempt = row.value.activeAttemptId; if (!attempt) return err('unavailable', 'No active attempt');
    const status = await this.o.runner.status(attempt); if (status.kind !== 'ok') return status as Result<never>;
    if (status.value.status !== 'complete' || !status.value.result) return err(status.value.status === 'failed' || status.value.status === 'cancelled' ? 'failed' : 'pending', `Runner status: ${status.value.status}`);
    const saved = await this.o.store.mutate(id, { action: 'worker-result', idempotencyKey: `result:${attempt}`, expectedRevision: row.value.revision, actor: 'runner', apply: r => { if (r.execution !== 'running' || r.activeAttemptId !== attempt) throw new DeskStoreError('conflict'); r.result = status.value.result!; r.execution = 'review'; return r; } });
    return ok(asJob(saved.record));
  }

  async release(id: string, request: ReleaseRequest): Promise<Result<OperatorJob>> {
    const row = await this.refresh(id); if (row.kind !== 'ok') return row;
    if (row.value.execution === 'released') return ok(asJob(row.value));
    if (row.value.backendPublication?.idempotencyKey === request.idempotencyKey) {
      if (row.value.backendPublication.release.artifactHash !== request.artifactHash || row.value.backendPublication.release.mediaType !== request.mediaType || row.value.backendPublication.release.publicDestination !== request.publicDestination) return err('denied', 'Publication key is already bound to different release terms');
      const reconciled = await this.o.publisher.reconcile(request.idempotencyKey);
      if (reconciled.kind !== 'ok') return reconciled as Result<never>;
      const refreshed = await this.refresh(id);
      return refreshed.kind === 'ok' ? ok(asJob(refreshed.value)) : refreshed;
    }
    if (row.value.pendingDeliveryIntent?.idempotencyKey === request.idempotencyKey && row.value.pendingDeliveryIntent.release.artifactHash === request.artifactHash && row.value.pendingDeliveryIntent.release.mediaType === request.mediaType && row.value.pendingDeliveryIntent.release.publicDestination === request.publicDestination) {
      return ok({ ...asJob(row.value), transactionIntent: { chainId: row.value.pendingDeliveryIntent.chainId, transaction: row.value.pendingDeliveryIntent.transaction, requiredCreator: row.value.publicState.claim?.provider } });
    }
    if (!row.value.result || row.value.execution !== 'review' || !row.value.publicState.claim) return err('denied', 'Only a reviewed result with a verified provider claim can be released');
    const r = row.value.result;
    if (!checkRelease({ artifactHash: r.artifactHash, mediaType: r.mediaType, publicDestination: request.publicDestination }, request, row.value.revision)) return err('denied', 'Release payload does not match the reviewed artifact');
    let bytes: Uint8Array; try { bytes = await this.o.artifactBytes(r.artifactRef); } catch { return err('unavailable', 'Approved artifact bytes are unavailable'); }
    if (await artifactDigest(bytes) !== r.artifactHash) return err('denied', 'Artifact bytes changed after review');
    const snapshot = await this.o.snapshots.snapshot(id); if (snapshot.kind !== 'ok') return snapshot;
    const claimObservation = snapshot.value.find(o => (o.record as { type?: string; executionId?: string }).type === 'claim' && (o.record as { executionId?: string }).executionId === row.value.activeAttemptId);
    if (!claimObservation) return err('unavailable', 'Verified provider claim reference is missing');
    if (this.o.backendSigner && this.o.backendSigner.toLowerCase() === row.value.publicState.claim.provider.toLowerCase()) {
      let reserved: AssignmentRecord;
      try {
        reserved = (await this.o.store.mutate(id, { action: 'backend-release', idempotencyKey: request.idempotencyKey, expectedRevision: request.expectedRevision, actor: 'operator', apply: current => {
          if (current.execution !== 'review' || !current.result || current.result.artifactHash !== request.artifactHash || current.backendPublication) throw new DeskStoreError('conflict');
          current.backendPublication = { idempotencyKey: request.idempotencyKey, claimRef: claimObservation.ref, release: { artifactHash: request.artifactHash, mediaType: request.mediaType, publicDestination: request.publicDestination } };
          return current;
        } })).record;
      } catch (e) { return this.storeError(e); }
      const published = await this.o.publisher.publish(claimObservation.ref, reserved.backendPublication!.release, request.idempotencyKey);
      if (published.kind !== 'ok' && published.kind !== 'pending') return published as Result<never>;
      const refreshed = await this.refresh(id);
      return refreshed.kind === 'ok' ? ok(asJob(refreshed.value)) : refreshed;
    }
    const prepared = await this.o.providerTransactions.prepareDelivery({ claimRef: claimObservation.ref, provider: row.value.publicState.claim.provider, artifactHash: r.artifactHash, mediaType: r.mediaType, publicDestination: request.publicDestination, idempotencyKey: request.idempotencyKey });
    if (prepared.kind !== 'ok') return prepared as Result<never>;
    const saved = await this.o.store.mutate(id, { action: 'release-intent', idempotencyKey: request.idempotencyKey, expectedRevision: request.expectedRevision, actor: 'operator', apply: current => { if (current.execution !== 'review' || !current.result || current.result.artifactHash !== request.artifactHash) throw new DeskStoreError('conflict'); current.pendingDeliveryIntent = { chainId: prepared.value.chainId, transaction: prepared.value.transaction, idempotencyKey: request.idempotencyKey, release: { artifactHash: request.artifactHash, mediaType: request.mediaType, publicDestination: request.publicDestination } }; return current; } });
    return ok({ ...asJob(saved.record), transactionIntent: { chainId: prepared.value.chainId, transaction: prepared.value.transaction, requiredCreator: saved.record.publicState.claim?.provider } });
  }

  async prepareClaim(id: string, request: Mutation): Promise<Result<ProviderWalletIntent>> {
    const row = await this.ensure(id); if (row.kind !== 'ok') return row;
    const existing = row.value.walletIntents?.claim;
    if (existing) return this.walletIntent(id, 'claim');
    const a = row.value.approval; if (!a) return err('denied', 'Operator approval is required');
    const dispatched = await this.dispatch(id, request, a.corpusDigest, a.inputRefs, a.planDigest, a.limits, a.audience);
    if (dispatched.kind !== 'ok') return dispatched;
    if (dispatched.value.claimTransaction === null) return err('pending', 'Backend claim publication is awaiting finalized reconciliation');
    // Re-query the trusted adapter to preserve its explicit chain; legacy dispatch returns only calldata.
    const current = await this.ensure(id); if (current.kind !== 'ok') return current;
    const r = current.value;
    const prepared = await this.o.providerTransactions.prepareClaim({ acceptanceRef: r.publicState.acceptanceRef!, provider: r.publicState.offer!.provider, executionId: dispatched.value.attemptId, idempotencyKey: r.dispatchIdempotencyKey! });
    if (prepared.kind !== 'ok') return prepared;
    return this.saveWalletIntent(r, 'claim', prepared.value);
  }

  async prepareDelivery(id: string, request: ReleaseRequest): Promise<Result<ProviderWalletIntent>> {
    const row = await this.ensure(id); if (row.kind !== 'ok') return row;
    const prior = row.value.walletIntents?.delivery?.intent;
    if (prior) {
      if (prior.artifactHash !== request.artifactHash || prior.mediaType !== request.mediaType || prior.publicDestination !== request.publicDestination) return err('denied', 'Delivery already bound to approved terms');
      return this.walletIntent(id, 'delivery');
    }
    const released = await this.release(id, request); if (released.kind !== 'ok') return released;
    const current = await this.ensure(id); if (current.kind !== 'ok') return current;
    const pending = current.value.pendingDeliveryIntent;
    if (!pending) return err('unavailable', 'Unsigned delivery is unavailable');
    return this.saveWalletIntent(current.value, 'delivery', pending);
  }

  private async saveWalletIntent(row: AssignmentRecord, action: 'claim' | 'delivery', prepared: { chainId: string; transaction: unknown }): Promise<Result<ProviderWalletIntent>> {
    try {
      const creator = row.publicState.offer?.provider;
      if (!creator || !row.approval || !row.activeAttemptId || !row.publicState.acceptanceDigest) return err('denied', 'Missing approved signing binding');
      const transaction = walletTransaction(prepared.transaction, creator, prepared.chainId);
      const intent: ProviderWalletIntent = {
        version: 'desk-wallet/v1', intentRef: randomUUID(), action, jobRef: row.id,
        requiredCreator: creator, chainId: transaction.chainId, transaction,
        expiresAt: Math.min(row.approval.expiresAt, timestamp(this.o) + 900),
        acceptanceDigest: row.publicState.acceptanceDigest, executionId: row.activeAttemptId,
        ...(action === 'delivery' ? row.pendingDeliveryIntent?.release : {}),
      };
      validateWalletIntent(intent, timestamp(this.o));
      const saved = await this.o.store.mutate(row.id, { action: `wallet-prepare:${action}`, idempotencyKey: `wallet-prepare:${action}:${row.activeAttemptId}`, expectedRevision: row.revision, actor: 'operator', apply: current => {
        current.walletIntents = { ...current.walletIntents, [action]: { intent } }; return current;
      } });
      return ok(saved.record.walletIntents![action]!.intent);
    } catch (e) { return err('unavailable', e instanceof Error ? e.message : 'Unsigned provider transaction unavailable'); }
  }

  async walletIntent(id: string, action: 'claim' | 'delivery'): Promise<Result<ProviderWalletIntent>> {
    const row = await this.refresh(id); if (row.kind !== 'ok') return row;
    const intent = row.value.walletIntents?.[action]?.intent;
    if (!intent) return err('unavailable', 'No prepared signing intent');
    try { validateWalletIntent(intent, timestamp(this.o)); } catch { return err('denied', 'Signing intent expired; operator intervention required'); }
    if ((action === 'claim' && (row.value.execution !== 'queued' || row.value.publicState.claim?.executionId === intent.executionId)) || (action === 'delivery' && row.value.execution !== 'review')) return err('denied', 'Signing action is no longer awaiting a provider signature');
    if (['cancelled','failed','expired'].includes(row.value.execution) || intent.acceptanceDigest !== row.value.publicState.acceptanceDigest || intent.executionId !== row.value.activeAttemptId || intent.requiredCreator !== row.value.publicState.offer?.provider) return err('denied', 'Signing intent no longer matches authoritative state');
    if (action === 'delivery' && (row.value.result?.artifactHash !== intent.artifactHash || row.value.pendingDeliveryIntent?.release.publicDestination !== intent.publicDestination)) return err('denied', 'Approved artifact or destination changed');
    return ok(intent);
  }

  async submitWallet(id: string, action: 'claim' | 'delivery', request: WalletSubmission): Promise<Result<{ status: 'pending'; txHash: string }>> {
    const checked = await this.walletIntent(id, action); if (checked.kind !== 'ok') return checked;
    if (!walletHash(request.txHash) || request.intentRef !== checked.value.intentRef) return err('denied', 'Transaction intent mismatch');
    const row = await this.ensure(id); if (row.kind !== 'ok') return row;
    const prior = row.value.walletIntents?.[action]?.txHash;
    if (prior && prior !== request.txHash) return err('denied', 'A different transaction is already submitted');
    try {
      const saved = await this.o.store.mutate(id, { action: `wallet-submit:${action}`, idempotencyKey: `wallet-submit:${request.intentRef}`, expectedRevision: row.value.revision, actor: 'provider-wallet', apply: current => {
        const entry = current.walletIntents?.[action];
        if (!entry || entry.intent.intentRef !== request.intentRef || entry.intent.expiresAt <= timestamp(this.o) || entry.intent.acceptanceDigest !== current.publicState.acceptanceDigest || entry.intent.executionId !== current.activeAttemptId || !['queued', 'review'].includes(current.execution)) throw new DeskStoreError('conflict');
        entry.txHash = request.txHash; return current;
      } });
      if (saved.record.walletIntents?.[action]?.txHash !== request.txHash) return err('denied', 'A different transaction was recorded concurrently');
      return ok({ status: 'pending', txHash: request.txHash });
    } catch (e) { return this.storeError(e); }
  }

  async reconcileWallet(id: string, action: 'claim' | 'delivery'): Promise<Result<OperatorJob>> {
    const row = await this.refresh(id); if (row.kind !== 'ok') return row;
    if (action === 'claim') {
      if (['running','review','released'].includes(row.value.execution)) return ok(asJob(row.value));
      return this.reconcileClaim(id);
    }
    const intent = row.value.walletIntents?.delivery?.intent, state = row.value.publicState;
    if (!intent || !state.delivery || state.conflict || state.claim?.executionId !== intent.executionId || state.delivery.provider !== intent.requiredCreator || state.delivery.artifactHash !== intent.artifactHash || state.delivery.mediaType !== intent.mediaType || state.delivery.publicRef !== intent.publicDestination) return err('pending', 'Matching provider delivery is not yet finalized');
    if (row.value.execution === 'released') return ok(asJob(row.value));
    try {
      const saved = await this.o.store.mutate(id, { action: 'wallet-delivery-confirmed', idempotencyKey: `wallet-confirm:${intent.intentRef}`, expectedRevision: row.value.revision, actor: 'public-reader', apply: current => {
        if (current.execution !== 'review') throw new DeskStoreError('invalid-state'); current.execution = 'released'; return current;
      } });
      return ok(asJob(saved.record));
    } catch (e) { return this.storeError(e); }
  }

  async reconcilePayment(id: string, txHash: string): Promise<Result<OperatorJob>> {
    const row = await this.refresh(id); if (row.kind !== 'ok') return row;
    const { job, offer, acceptanceRef } = row.value.publicState;
    if (!job || !offer || !acceptanceRef) return err('denied', 'Payment requires an accepted offer');
    if (row.value.execution !== 'released' || !row.value.publicState.delivery) return err('denied', 'Payment cannot be assigned before a verified public delivery');
    const intent = { jobRef: id, acceptanceRef, chainId: offer.paymentChainId, payer: job.client, recipient: offer.recipient, asset: offer.asset, amountAtomic: offer.amountAtomic, transferInterface: offer.transferInterface };
    const verified = await this.o.settlement.verify(intent, txHash); if (verified.kind !== 'ok') return verified as Result<never>;
    if (!await this.o.store.reservePayment(id, verified.value.receiptId)) return err('denied', 'Payment receipt was already allocated');
    const snap = await this.o.snapshots.snapshot(id); if (snap.kind !== 'ok') return snap;
    const state = await reducePublicState(snap.value, id, timestamp(this.o), [verified.value]);
    if (state.stage !== 'paid') return err('pending', 'Verified transfer is not yet present in the finalized public snapshot');
    const updated = await this.o.store.mutate(id, { action: 'payment-confirmed', idempotencyKey: `receipt:${verified.value.receiptId}`, expectedRevision: row.value.revision, actor: 'settlement', apply: r => { r.paymentReceiptId = verified.value.receiptId; r.publicState = state; return r; } });
    return ok(asJob(updated.record));
  }

  private async ensure(id: string): Promise<Result<AssignmentRecord>> { const row = await this.o.store.get(id); return row ? ok(row) : this.refresh(id); }
  private async change(id: string, action: string, request: Mutation, apply: (r: AssignmentRecord) => AssignmentRecord): Promise<Result<OperatorJob>> {
    const row = await this.ensure(id); if (row.kind !== 'ok') return row;
    if (!checkMutation(request, row.value.revision)) return err('invalid-input', 'Mutation revision or idempotency key is invalid');
    try { const saved = await this.o.store.mutate(id, { action, idempotencyKey: request.idempotencyKey, expectedRevision: request.expectedRevision, actor: 'operator', apply }); return ok(asJob(saved.record)); } catch (e) { return this.storeError(e); }
  }
  private storeError(e: unknown): Result<never> {
    if (e instanceof DeskStoreError) return e.code === 'not-found' ? err('unavailable', 'Assignment not found') : e.code === 'stale-revision' ? err('invalid-input', 'Stale revision') : err('denied', `Mutation rejected: ${e.code}`);
    return err('unavailable', 'Persistence operation failed');
  }
}
