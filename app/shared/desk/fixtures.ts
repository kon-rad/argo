/** Synthetic examples only. Never configure these adapters for production. */
import { CONTRACT_VERSION, type Acceptance, type Claim, type Delivery, type DeskClient, type DeskIdentity, type DeskOperatorApi, type DeskPublicStore, type DeskPublisher, type DeskRunner, type DeskSettlement, type DispatchContext, type Job, type Observation, type Offer, type PaymentEvidence, type Result } from './types.js';
const base = {version: CONTRACT_VERSION, domain:'example-desk', chainId:'arkiv:test'};
const jobRef = 'arkiv:test/job-1', offerRef = 'arkiv:test/offer-1', acceptanceRef = 'arkiv:test/acceptance-1';
const job: Job = {...base,type:'job',jobId:'job-1',nonce:'job-nonce',client:'wallet:client',skill:'research',brief:'Summarize the public sample corpus.',budgetAtomic:'900719925474099312345',asset:'USDC',paymentChainId:'arc:test',deadline:1000};
const offer: Offer = {...base,type:'offer',jobRef,providerId:'provider-1',provider:'wallet:provider',skillVersion:'research/1',amountAtomic:'900719925474099312345',paymentChainId:'arc:test',asset:'USDC',recipient:'wallet:provider',transferInterface:'unselected',expiresAt:900};
const acceptance: Acceptance = {...base,type:'acceptance',jobRef,offerRef,client:'wallet:client',offerDigest:'sha256:aa217a81ce8ae18199852ea2eaada62afe2150a840b76229cf4e935d8cea051f',nonce:'nonce-a',expiresAt:800};
const observation = (ref: string, creator: string, observedAt: number, record: unknown): Observation => ({ref,creator,observedAt,record,finalized:true});
const jobObs = observation(jobRef,job.client,100,job), offerObs = observation(offerRef,offer.provider,110,offer), acceptanceObs = observation(acceptanceRef,job.client,120,acceptance);
const claim: Claim = {...base,type:'claim',acceptanceRef,provider:offer.provider,executionId:'attempt-1'};
const delivery: Delivery = {...base,type:'delivery',claimRef:'arkiv:test/claim-1',provider:offer.provider,artifactHash:'sha256:'+'a'.repeat(64),mediaType:'text/markdown',publicRef:'swarm://'+'b'.repeat(64)};
const payment: PaymentEvidence = {...base,type:'payment',jobRef,acceptanceRef,paymentChainId:offer.paymentChainId,txHash:'tx-example',transferIndex:'0',payer:job.client,recipient:offer.recipient,asset:offer.asset,amountAtomic:offer.amountAtomic,transferInterface:offer.transferInterface};
const success = [jobObs,offerObs,acceptanceObs];
const dispatchContext: DispatchContext = {now:150,approvedAcceptanceDigest:'sha256:7d2df923622d81db13cc5a090511a44696eae2a484c718fb80df0db21f25b220',approvedSkillVersion:offer.skillVersion,eligibleProviders:[{providerId:offer.providerId,owner:offer.provider,skill:job.skill,skillVersion:offer.skillVersion}],activeAttempt:false,cancelled:false};
const release = {artifactHash:delivery.artifactHash, mediaType:delivery.mediaType, publicDestination:delivery.publicRef};
export const fixtures = {
  jobRef, job, offer, acceptance, claim, delivery, payment, success, dispatchContext,
  publicDocuments: [
    {id:'doc-1',text:'A fictional city maintains a public garden.'},
    {id:'doc-2',text:'Volunteers water the garden each morning.'},
    {id:'doc-3',text:'The garden records rainfall in a public log.'},
  ],
  expectedResearch: {summary:'A public garden is maintained by volunteers.', sources:['doc-1','doc-2'], limitations:['Synthetic sample']},
  invalidAuthor: [jobObs,offerObs,observation(acceptanceRef,'wallet:forger',120,acceptance)],
  conflictingAcceptance: [...success,observation('arkiv:test/acceptance-2',job.client,130,{...acceptance,nonce:'nonce-b'})],
  replay: [...success,observation('arkiv:test/other-acceptance',job.client,125,{...acceptance,jobRef:'arkiv:test/other-job'})],
  expiredOffer: [jobObs,observation(offerRef,offer.provider,110,{...offer,expiresAt:115}),acceptanceObs],
  wrongChain: [jobObs,offerObs,observation('arkiv:other/acceptance-1',job.client,120,{...acceptance,chainId:'arkiv:other'})],
  unverifiedPayment: [...success,observation('arkiv:test/claim-1',offer.provider,130,claim),observation('arkiv:test/delivery-1',offer.provider,140,delivery),observation('arkiv:test/payment-1',job.client,145,payment)],
  cancellation: {...dispatchContext,cancelled:true},
  changedArtifact: {approval:release,request:{...release,artifactHash:'sha256:'+'c'.repeat(64)}},
  unknownTransaction: {kind:'pending',message:'Transaction status unknown'} as const,
  rejectedWallet: {kind:'denied',message:'Wallet rejected transaction'} as const,
};
const unavailable: Result<never> = {kind:'unavailable',message:'Fixture adapter has no handler'};
type Failure = Exclude<Result<never>, {kind:'ok'}>;
export function fakePublicStore(failure: Failure = unavailable as Failure): DeskPublicStore { return {mode:'fixture',listJobs:async()=>failure,get:async()=>failure,publish:async()=>failure,confirmation:async()=>failure}; }
export function fakeIdentity(): DeskIdentity { return {mode:'fixture',profile:async()=>unavailable,resolve:async()=>unavailable}; }
export function fakeRunner(): DeskRunner { return {mode:'fixture',start:async()=>unavailable,status:async()=>unavailable,cancel:async()=>unavailable}; }
export function fakePublisher(): DeskPublisher { return {mode:'fixture',publish:async()=>unavailable,reconcile:async()=>unavailable}; }
export function fakeSettlement(): DeskSettlement { return {mode:'fixture',prepare:async()=>unavailable,verify:async()=>unavailable,reconcile:async()=>unavailable}; }
export function fakeOperatorApi(): DeskOperatorApi { return {mode:'fixture',inbox:async()=>unavailable,jobs:async()=>unavailable,job:async()=>unavailable,providers:async()=>unavailable,approve:async()=>unavailable,decline:async()=>unavailable,cancel:async()=>unavailable,preview:async()=>unavailable,release:async()=>unavailable}; }
export function fakeClient(): DeskClient { return {mode:'fixture',discover:async()=>unavailable,post:async()=>unavailable,offers:async()=>unavailable,accept:async()=>unavailable,inspect:async()=>unavailable,preparePayment:async()=>unavailable,independentRead:async()=>unavailable}; }
export function assertProductionAdapters(environment: string, adapters: readonly {mode:'live'|'fixture'}[]): void { if (environment === 'production' && adapters.some(adapter => adapter.mode !== 'live')) throw new Error('Fixture adapter forbidden in production'); }
/** Read-only successful synthetic snapshot, for demos and client integration tests. */
export function fakeSnapshotStore(snapshot: readonly Observation[] = fixtures.success): DeskPublicStore {
  const rows = [...snapshot];
  return {
    mode: 'fixture',
    listJobs: async () => ({kind:'ok',value:rows.filter(row => (row.record as {type?: unknown})?.type === 'job')}),
    get: async ref => {
      const row = rows.find(item => item.ref === ref);
      return row ? {kind:'ok',value:row} : {kind:'invalid-input',message:'Fixture entity not found'};
    },
    publish: async () => ({kind:'denied',message:'Fixture snapshot is read-only'}),
    confirmation: async () => ({kind:'pending',message:'Fixture snapshot has no transactions'}),
  };
}
