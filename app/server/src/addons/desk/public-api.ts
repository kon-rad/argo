import { parseRecord, reducePublicState, type DeskIdentity, type DeskPublicStore, type DeskSettlement, type Observation, type PaymentIntent, type PublicState } from '@secondbrain/desk-contracts/desk';
import type { DeskOrchestrator, DeskSnapshots } from './orchestration/service.js';
import type { AssignmentRecord, DeskPersistence } from './persistence/store.js';
import { formatAtomicToDecimal } from './settlement/arc.js';
import type { ArcReadClient } from './settlement/arc.js';

export interface DeskPublicControls {
  store: DeskPublicStore;
  identity?: DeskIdentity;
  settlement?: DeskSettlement;
  snapshots?: DeskSnapshots;
  persistence?: DeskPersistence;
  orchestrator?: Pick<DeskOrchestrator, 'refresh' | 'reconcilePayment'>;
  publicOrigin?: string;
  payment?: { chainId: string; interfaceId: string; tokenAddress: string };
  paymentReader?: ArcReadClient;
}

export class PublicDeskError extends Error {
  constructor(readonly status: number, readonly state: string, message: string) { super(message); }
}
const unavailable = () => new PublicDeskError(503, 'unavailable', 'Hiring Desk is temporarily unavailable.');
export function publicObservation(raw: Observation): Observation {
  // Explicit projection through the frozen public schema discards adapter metadata.
  return { ref: raw.ref, creator: raw.creator, observedAt: raw.observedAt, finalized: raw.finalized, record: parseRecord(raw.record) };
}
export async function snapshot(c: DeskPublicControls, ref: string): Promise<{ observations: Observation[]; state: PublicState }> {
  if (!c.snapshots) throw unavailable();
  const read = await c.snapshots.snapshot(ref);
  if (read.kind !== 'ok') throw unavailable();
  const observations = read.value.map(publicObservation);
  const state = await reducePublicState(observations, ref, Math.floor(Date.now() / 1000));
  if (!state.job) throw new PublicDeskError(404, 'not_payable', 'Public job was not found.');
  if (state.conflict) throw new PublicDeskError(409, 'not_payable', 'Public job records conflict.');
  return { observations, state };
}

export async function paymentContext(c: DeskPublicControls, ref: string) {
  if (!c.orchestrator || !c.persistence || !c.identity || !c.settlement || !c.payment) throw unavailable();
  const refreshed = await c.orchestrator.refresh(ref);
  if (refreshed.kind !== 'ok') throw unavailable();
  const row = refreshed.value, state = row.publicState;
  if (!state.job) throw new PublicDeskError(404, 'not_payable', 'Public job was not found.');
  if (['cancelled', 'expired', 'failed'].includes(row.execution)) return { row, response: { state: 'not_payable', reason: row.execution === 'expired' ? 'expired' : 'cancelled', message: 'This job is not payable.' } };
  if (!state.acceptance || !state.acceptanceRef || !state.offer || state.conflict) return { row, response: { state: 'not_payable', reason: 'not_accepted', message: 'Payment requires an accepted offer.' } };
  if (!state.delivery || row.execution !== 'released') return { row, response: { state: 'not_payable', reason: 'unknown', message: 'Payment is available after the reviewed delivery is released.' } };
  const offer = state.offer, job = state.job, configuration = c.payment;
  if (offer.paymentChainId !== configuration.chainId || offer.transferInterface !== configuration.interfaceId || offer.asset !== 'USDC' || configuration.interfaceId !== 'arc:testnet:erc20-usdc:transfer:v1') throw unavailable();
  const binding = await c.identity.resolve(offer.providerId);
  if (binding.kind !== 'ok') throw unavailable();
  const provider = binding.value.provider;
  if (!binding.value.verified || provider.owner !== offer.provider || provider.skill !== job.skill || provider.skillVersion !== offer.skillVersion || provider.paymentAddress.toLowerCase() !== offer.recipient.toLowerCase()) throw new PublicDeskError(409, 'not_payable', 'Accepted recipient cannot be independently verified.');
  const intent: PaymentIntent = { jobRef: ref, acceptanceRef: state.acceptanceRef, chainId: offer.paymentChainId, payer: job.client, recipient: provider.paymentAddress, asset: offer.asset, amountAtomic: offer.amountAtomic, transferInterface: offer.transferInterface };
  const prepared = await c.settlement.prepare(intent);
  if (prepared.kind !== 'ok') throw unavailable();
  const terms = { jobKey: ref, jobReference: ref, deliverableUrl: state.delivery.publicRef, recipientName: provider.providerId, recipientAddress: provider.paymentAddress, clientAddress: job.client, chainId: Number(configuration.chainId), tokenAddress: configuration.tokenAddress, amountBaseUnits: offer.amountAtomic, amountDisplay: formatAtomicToDecimal(offer.amountAtomic, 6), interfaceId: configuration.interfaceId };
  return { row, intent, terms, prepared: prepared.value };
}

/** The aggregate already lives in PostgreSQL. A submitted hash is deliberately kept separate from verified evidence. */
async function saveSubmission(c: DeskPublicControls, row: AssignmentRecord, txHash: string, status: 'pending' | 'failed') {
  if (!c.persistence) throw unavailable();
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await c.persistence.get(row.id);
    if (!current) throw unavailable();
    if (current.paymentSubmission?.txHash === txHash && current.paymentSubmission.status === status) return;
    if (current.paymentSubmission?.status === 'pending' && current.paymentSubmission.txHash !== txHash) throw new PublicDeskError(409, 'duplicate', 'A pending payment must be reconciled before another hash is submitted.');
    try {
      await c.persistence.mutate(row.id, { action: 'public-payment-submitted', idempotencyKey: `${txHash}:${status}:${current.revision}`, expectedRevision: current.revision, actor: 'public-client', apply: next => {
        if (next.paymentReceiptId && next.paymentSubmission?.txHash !== txHash) throw new PublicDeskError(409, 'duplicate', 'This job already has a verified payment.');
        if (next.paymentSubmission?.status === 'pending' && next.paymentSubmission.txHash !== txHash) throw new PublicDeskError(409, 'duplicate', 'A pending payment must be reconciled first.');
        next.paymentSubmission = { txHash, status }; return next;
      } });
      return;
    } catch (error) {
      if (error instanceof PublicDeskError) throw error;
      if (attempt === 2) throw unavailable();
    }
  }
}

export async function paymentStatus(c: DeskPublicControls, ref: string, submittedHash?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const context = await paymentContext(c, ref);
  if (context.response) return { status: 200, body: context.response };
  const { row, terms } = context;
  const txHash = submittedHash?.toLowerCase() ?? row.paymentSubmission?.txHash;
  if (!txHash) return { status: 200, body: { state: 'payable', terms } };
  if (!submittedHash && row.paymentSubmission?.status === 'failed') return { status: 200, body: { state: 'failed', terms, txHash, code: 'VERIFICATION_FAILED', message: 'Payment did not pass independent verification.', retryable: false } };
  if (row.paymentReceiptId && row.paymentSubmission?.txHash && row.paymentSubmission.txHash !== txHash) return { status: 409, body: { state: 'duplicate', txHash, message: 'This job already has a verified payment.' } };
  // A public caller cannot lock a job merely by inventing a hash. Only a known
  // transaction with the exact accepted sender, destination, value and calldata
  // may become a durable resume hint. A hint itself never proves payment.
  if (!c.paymentReader) throw unavailable();
  const expected = context.prepared.transaction as { to?: string; data?: string; value?: string };
  let transaction;
  try {
    if (await c.paymentReader.chainId() !== context.intent.chainId) throw unavailable();
    transaction = await c.paymentReader.transaction(txHash);
  } catch { throw unavailable(); }
  if (!transaction) return { status: 200, body: { state: 'pending', terms, txHash, confirmations: 0, warning: 'Transaction has not reached the independent reader yet.' } };
  let exact = false;
  try { exact = transaction.from.toLowerCase() === context.intent.payer.toLowerCase() && transaction.to?.toLowerCase() === expected.to?.toLowerCase() && BigInt(transaction.value) === 0n && (transaction.input ?? transaction.data ?? '0x').toLowerCase() === expected.data?.toLowerCase(); } catch { /* malformed RPC data cannot authorize a hint */ }
  if (!exact) return { status: 422, body: { state: 'failed', terms, txHash, code: 'VERIFICATION_FAILED', message: 'Transaction does not match the accepted payment terms.', retryable: false } };
  await saveSubmission(c, row, txHash, 'pending');
  // Both operations only read chain state. Reconciliation never submits a transfer.
  const result = await c.orchestrator!.reconcilePayment(ref, txHash);
  if (result.kind === 'unavailable') throw unavailable();
  if (result.kind === 'failed' || result.kind === 'invalid-input' || result.kind === 'denied') {
    await saveSubmission(c, row, txHash, 'failed');
    return { status: 422, body: { state: 'failed', terms, txHash, code: 'VERIFICATION_FAILED', message: 'Payment did not pass independent verification.', retryable: false } };
  }
  // The current desk/v1 reducer additionally requires finalized payer-authored public evidence.
  // A verified Arc hash without that binding remains pending; never invent an Arkiv observation.
  if (result.kind !== 'ok' || result.value.publicState.stage !== 'paid') return { status: 200, body: { state: 'pending', terms, txHash, confirmations: 0, warning: 'Waiting for independently verified public payment evidence.' } };
  const persisted = await c.persistence!.get(ref);
  if (!persisted?.paymentReceiptId || !new RegExp(`^arc:${terms.chainId}:${txHash}:(0|[1-9][0-9]*)$`).test(persisted.paymentReceiptId)) throw unavailable();
  return { status: 200, body: { state: 'confirmed', terms, receipt: { txHash, sender: terms.clientAddress, recipient: terms.recipientAddress, tokenAddress: terms.tokenAddress, chainId: terms.chainId, amountBaseUnits: terms.amountBaseUnits, receiptId: persisted.paymentReceiptId } } };
}
