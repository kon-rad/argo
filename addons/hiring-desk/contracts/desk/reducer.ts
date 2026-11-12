import { type Acceptance, type Claim, type Delivery, type DeskRecord, type DispatchContext, type ErrorCode, type Job, type Observation, type Offer, type PaymentEvidence, type PublicState, type VerifiedPayment } from './types.js';
import { canonicalJson, digest, isEntityRef, parseRecord } from './validation.js';

type Entry<T extends DeskRecord = DeskRecord> = { ref: string; creator: string; observedAt: number; record: T };
/** Reduce a complete finalized observation set. Incomplete queries cannot establish absence of conflicts. */
export async function reducePublicState(observations: readonly Observation[], jobRef: string, now: number, verifiedPayments: readonly VerifiedPayment[] = []): Promise<PublicState> {
  const state: PublicState = { stage: 'unknown', jobRef, conflict: false, rejected: [] };
  const reject = (ref: string, code: ErrorCode) => { state.rejected.push({ref, code}); };
  if (!isEntityRef(jobRef) || !Number.isSafeInteger(now) || now < 0) { reject(jobRef, 'INVALID_INPUT'); return state; }
  const byRef = new Map<string, Entry[]>();
  for (const raw of observations) {
    try {
      if (!raw || !isEntityRef(raw.ref) || typeof raw.creator !== 'string' || !raw.creator || !Number.isSafeInteger(raw.observedAt) || raw.observedAt < 0 || raw.observedAt > now || raw.finalized !== true) throw Error();
      const record = parseRecord(raw.record);
      if (!raw.ref.startsWith(record.chainId + '/')) throw Error();
      const entry = {ref: raw.ref, creator: raw.creator, observedAt: raw.observedAt, record};
      const entries = byRef.get(raw.ref) ?? []; entries.push(entry); byRef.set(raw.ref, entries);
    } catch { reject(typeof raw?.ref === 'string' ? raw.ref : '', 'INVALID_INPUT'); }
  }
  const entries: Entry[] = [];
  for (const [ref, group] of byRef) {
    if (new Set(group.map(canonicalJson)).size !== 1) { reject(ref, 'CONFLICT'); state.conflict = true; continue; }
    const entry = group[0];
    if (entry) entries.push(entry);
  }
  entries.sort((a,b) => a.observedAt - b.observedAt || compare(a.ref,b.ref));
  const get = <T extends DeskRecord['type']>(type: T) => entries.filter((e): e is Entry<Extract<DeskRecord, {type:T}>> => e.record.type === type);
  const found = get('job').find(e => e.ref === jobRef);
  if (!found) { reject(jobRef, 'MISSING_DEPENDENCY'); return finish(state); }
  const job = found.record;
  if (found.creator !== job.client) { reject(found.ref, 'AUTHOR_MISMATCH'); return finish(state); }
  state.job = job; state.stage = 'posted';
  if (state.conflict) return finish(state);
  const sameDomain = (e: Entry) => e.record.domain === job.domain && e.record.chainId === job.chainId;
  const offers: Entry<Offer>[] = [];
  for (const e of get('offer').filter(e => e.record.jobRef === jobRef)) {
    const o = e.record;
    if (!sameDomain(e)) reject(e.ref, 'WRONG_DOMAIN');
    else if (e.creator !== o.provider) reject(e.ref, 'AUTHOR_MISMATCH');
    else if (e.observedAt < found.observedAt || e.observedAt >= o.expiresAt || o.expiresAt > job.deadline) reject(e.ref, 'EXPIRED');
    else if (o.paymentChainId !== job.paymentChainId || o.asset !== job.asset || BigInt(o.amountAtomic) > BigInt(job.budgetAtomic)) reject(e.ref, 'TERMS_MISMATCH');
    else offers.push(e);
  }
  const firstOffer = offers[0];
  if (firstOffer) { state.stage = 'offered'; state.offer = firstOffer.record; state.offerRef = firstOffer.ref; }
  const candidates: Entry<Acceptance>[] = [];
  for (const e of get('acceptance').filter(e => e.record.jobRef === jobRef)) {
    const a = e.record; const offer = offers.find(o => o.ref === a.offerRef);
    if (!sameDomain(e)) reject(e.ref, 'WRONG_DOMAIN');
    else if (e.creator !== job.client || a.client !== job.client) reject(e.ref, 'AUTHOR_MISMATCH');
    else if (!offer) reject(e.ref, 'MISSING_DEPENDENCY');
    else if (e.observedAt < offer.observedAt || e.observedAt >= a.expiresAt || e.observedAt >= offer.record.expiresAt || a.expiresAt > offer.record.expiresAt || a.expiresAt > job.deadline) reject(e.ref, 'EXPIRED');
    else if (a.offerDigest !== await digest('offer-terms', offer.record)) reject(e.ref, 'TERMS_MISMATCH');
    else {
      // A nonce is scoped to the authenticated author, domain and chain, across all jobs.
      const replay = get('acceptance').some(other => other.ref !== e.ref && other.creator === e.creator && other.record.client === e.creator && other.record.domain === a.domain && other.record.chainId === a.chainId && other.record.nonce === a.nonce && canonicalJson(other.record) !== canonicalJson(a));
      if (replay) reject(e.ref, 'REPLAY'); else candidates.push(e);
    }
  }
  // Identical publications are idempotent; distinct valid terms are ambiguous even if observed late.
  const distinct = new Map<string, Entry<Acceptance>>();
  for (const candidate of candidates) if (!distinct.has(canonicalJson(candidate.record))) distinct.set(canonicalJson(candidate.record), candidate);
  if (distinct.size > 1) { state.conflict = true; for (const e of distinct.values()) reject(e.ref, 'CONFLICT'); return finish(state); }
  const accepted = [...distinct.values()][0];
  if (!accepted) return finish(state);
  const selectedOffer = offers.find(e => e.ref === accepted.record.offerRef);
  if (!selectedOffer) { reject(accepted.ref, 'MISSING_DEPENDENCY'); return finish(state); }
  state.offer = selectedOffer.record; state.offerRef = selectedOffer.ref; state.acceptance = accepted.record; state.acceptanceRef = accepted.ref;
  state.acceptanceDigest = await digest('acceptance', accepted.record); state.stage = 'accepted';
  const claims: Entry<Claim>[] = [];
  for (const e of get('claim').filter(e => e.record.acceptanceRef === accepted.ref)) {
    if (!sameDomain(e)) reject(e.ref, 'WRONG_DOMAIN');
    else if (e.creator !== selectedOffer.record.provider || e.record.provider !== e.creator) reject(e.ref, 'AUTHOR_MISMATCH');
    else if (e.observedAt < accepted.observedAt || e.observedAt >= accepted.record.expiresAt) reject(e.ref, 'EXPIRED');
    else claims.push(e);
  }
  if (claims.length > 1) { state.conflict = true; claims.forEach(e => reject(e.ref, 'CONFLICT')); return finish(state); }
  const claim = claims[0]; if (!claim) return finish(state);
  state.claim = claim.record; state.stage = 'claimed';
  const deliveries: Entry<Delivery>[] = [];
  for (const e of get('delivery').filter(e => e.record.claimRef === claim.ref)) {
    if (!sameDomain(e)) reject(e.ref, 'WRONG_DOMAIN');
    else if (e.creator !== selectedOffer.record.provider || e.record.provider !== e.creator) reject(e.ref, 'AUTHOR_MISMATCH');
    else if (e.observedAt < claim.observedAt) reject(e.ref, 'TERMS_MISMATCH');
    else deliveries.push(e);
  }
  if (deliveries.length > 1) { state.conflict = true; deliveries.forEach(e => reject(e.ref, 'CONFLICT')); return finish(state); }
  const delivery = deliveries[0]; if (!delivery) return finish(state);
  state.delivery = delivery.record; state.stage = 'delivered';
  for (const e of get('payment').filter(e => e.record.jobRef === jobRef)) {
    const p: PaymentEvidence = e.record; const o = selectedOffer.record;
    if (!sameDomain(e)) reject(e.ref, 'WRONG_DOMAIN');
    else if (e.creator !== job.client || p.payer !== job.client) reject(e.ref, 'AUTHOR_MISMATCH');
    else if (e.observedAt < delivery.observedAt || p.acceptanceRef !== accepted.ref || p.paymentChainId !== o.paymentChainId || p.recipient !== o.recipient || p.asset !== o.asset || p.amountAtomic !== o.amountAtomic || p.transferInterface !== o.transferInterface) reject(e.ref, 'TERMS_MISMATCH');
    else {
      const evidenceDigest = await digest('payment-evidence', p);
      if (!verifiedPayments.some(v => v.evidenceRef === e.ref && v.evidenceDigest === evidenceDigest && v.verified === true && v.receiptId)) reject(e.ref, 'PENDING');
      else state.stage = 'paid';
    }
  }
  return finish(state);
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function finish(state: PublicState): PublicState { state.rejected.sort((a,b) => compare(a.ref,b.ref) || compare(a.code,b.code)); return state; }
export function dispatchEligibility(state: PublicState, context: DispatchContext): { ok: true } | { ok: false; code: ErrorCode } {
  const { job, offer, acceptance } = state;
  if (!job || !offer || !acceptance || !state.acceptanceDigest || state.conflict || state.stage !== 'accepted') return {ok:false, code:'DENIED'};
  if (!Number.isSafeInteger(context.now) || context.now < 0 || context.now >= acceptance.expiresAt || context.now >= offer.expiresAt || context.now >= job.deadline) return {ok:false, code:'EXPIRED'};
  if (context.cancelled || context.activeAttempt || context.approvedAcceptanceDigest !== state.acceptanceDigest || context.approvedSkillVersion !== offer.skillVersion || !context.eligibleProviders.some(p => p.providerId === offer.providerId && p.owner === offer.provider && p.skill === job.skill && p.skillVersion === offer.skillVersion)) return {ok:false, code:'DENIED'};
  return {ok:true};
}
