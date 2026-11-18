#!/usr/bin/env node
// Independent reader entry point. A public chain adapter module is supplied by integration.
const [ref, adapterPath] = process.argv.slice(2);
if (!ref || !adapterPath || !process.env.DESK_PUBLIC_RPC_URL) {
  console.error('Usage: DESK_PUBLIC_RPC_URL=https://… desk-reader <entity-ref> <adapter-module>');
  process.exit(2);
}
try {
  const moduleUrl = new URL(adapterPath, `file://${process.cwd()}/`);
  const { readPublicEvidence } = await import(moduleUrl.href);
  if (typeof readPublicEvidence !== 'function') throw new Error('Adapter must export readPublicEvidence({ rpcUrl, jobRef })');
  const evidence = await readPublicEvidence({ rpcUrl: process.env.DESK_PUBLIC_RPC_URL, jobRef: ref });
  if (!evidence || !Array.isArray(evidence.observations) || !Array.isArray(evidence.verifiedPayments)) throw new Error('Reader adapter must return complete observations and independently verified payments');
  const { reducePublicState } = await import('@secondbrain/desk-contracts/desk');
  const state = await reducePublicState(evidence.observations, ref, Math.floor(Date.now() / 1000), evidence.verifiedPayments);
  const blocking = state.rejected.filter(item => item.code !== 'PENDING');
  const evidenceSummary = {
    jobRef: state.jobRef,
    stage: state.stage,
    acceptanceRef: state.acceptanceRef,
    artifactHash: state.delivery?.artifactHash,
    paymentEvidence: evidence.verifiedPayments.filter(item => item.verified).map(({ evidenceRef, evidenceDigest, receiptId }) => ({ evidenceRef, evidenceDigest, receiptId })),
    observationRefs: evidence.observations.map(item => item.ref),
  };
  if (state.stage === 'unknown' || state.conflict || blocking.length) {
    console.error(JSON.stringify({ verified: false, evidence: evidenceSummary, conflict: state.conflict, rejected: state.rejected }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ verified: true, paymentVerified: state.stage === 'paid', evidence: evidenceSummary, state }, null, 2));
} catch (error) {
  console.error(`Independent read failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
