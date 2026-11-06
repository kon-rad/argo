/** Public wire format. Timestamps are Unix seconds; atomic quantities are canonical decimal strings. */
export const CONTRACT_VERSION = 'desk/v1' as const;
export type Decimal = string;
export type EntityRef = string;
export type Wallet = string;
export type Hash = string;
export interface Base { version: typeof CONTRACT_VERSION; domain: string; chainId: string; }
export interface Provider extends Base { type: 'provider'; providerId: string; profileRef: string; owner: Wallet; skill: string; skillVersion: string; identityRefs: string[]; paymentAddress: Wallet }
export interface Job extends Base { type: 'job'; jobId: string; nonce: string; client: Wallet; skill: string; brief: string; budgetAtomic: Decimal; asset: string; paymentChainId: string; deadline: number }
export interface Offer extends Base { type: 'offer'; jobRef: EntityRef; providerId: string; provider: Wallet; skillVersion: string; amountAtomic: Decimal; paymentChainId: string; asset: string; recipient: Wallet; transferInterface: string; expiresAt: number }
export interface Acceptance extends Base { type: 'acceptance'; jobRef: EntityRef; offerRef: EntityRef; client: Wallet; offerDigest: Hash; nonce: string; expiresAt: number }
export interface Claim extends Base { type: 'claim'; acceptanceRef: EntityRef; provider: Wallet; executionId: string }
export interface Delivery extends Base { type: 'delivery'; claimRef: EntityRef; provider: Wallet; artifactHash: Hash; mediaType: string; publicRef: string }
export interface PaymentEvidence extends Base { type: 'payment'; jobRef: EntityRef; acceptanceRef: EntityRef; paymentChainId: string; txHash: string; transferIndex: string; payer: Wallet; recipient: Wallet; asset: string; amountAtomic: Decimal; transferInterface: string }
export type DeskRecord = Provider | Job | Offer | Acceptance | Claim | Delivery | PaymentEvidence;
/** Adapter supplies these observations only after independently verifying chain inclusion, creator, finality and timestamp. */
export interface Observation { ref: EntityRef; creator: Wallet; observedAt: number; finalized: boolean; record: unknown }
export type ErrorCode = 'INVALID_INPUT' | 'AUTHOR_MISMATCH' | 'WRONG_DOMAIN' | 'EXPIRED' | 'REPLAY' | 'CONFLICT' | 'MISSING_DEPENDENCY' | 'TERMS_MISMATCH' | 'DENIED' | 'PENDING' | 'UNAVAILABLE' | 'FAILED' | 'STALE_REVISION';
export interface Rejection { ref: EntityRef; code: ErrorCode }
export type PublicStage = 'unknown' | 'posted' | 'offered' | 'accepted' | 'claimed' | 'delivered' | 'paid';
export interface VerifiedPayment { evidenceRef: EntityRef; evidenceDigest: Hash; receiptId: string; /** Trusted verifier confirms exact binding and reserves this receipt in its durable ledger. */ verified: true }
export interface PublicState { stage: PublicStage; job?: Job; jobRef: EntityRef; offer?: Offer; offerRef?: EntityRef; acceptance?: Acceptance; acceptanceRef?: EntityRef; acceptanceDigest?: Hash; claim?: Claim; delivery?: Delivery; conflict: boolean; rejected: Rejection[] }
export interface DispatchContext { now: number; approvedAcceptanceDigest: Hash; approvedSkillVersion: string; eligibleProviders: readonly { providerId: string; owner: Wallet; skill: string; skillVersion: string }[]; activeAttempt: boolean; cancelled: boolean }
export type Result<T> = { kind: 'ok'; value: T } | { kind: 'invalid-input' | 'denied' | 'pending' | 'unavailable' | 'failed'; message: string };
export interface Adapter { readonly mode: 'live' | 'fixture' }
export interface Confirmation { status: 'pending' | 'confirmed' | 'failed'; ref?: EntityRef; transactionHash?: string }
export interface DeskPublicStore extends Adapter { listJobs(): Promise<Result<Observation[]>>; get(ref: EntityRef): Promise<Result<Observation>>; publish(record: DeskRecord, idempotencyKey: string): Promise<Result<Confirmation>>; confirmation(ref: string): Promise<Result<Confirmation>> }
export interface IdentityBinding { provider: Provider; verified: boolean; evidence: readonly string[] }
export interface DeskIdentity extends Adapter { profile(providerId: string): Promise<Result<Provider>>; resolve(providerId: string): Promise<Result<IdentityBinding>> }
export interface WorkerLimits { readonly tools: readonly string[]; readonly model: string; readonly maxCostAtomic: Decimal; readonly costAsset: string; readonly maxRuntimeSeconds: number; readonly maxOutputTokens: number }
/** Immutable approved dispatch; bearer capability must be enforced by the gateway, never trusted as a callback. */
export interface WorkerSpec { readonly version: typeof CONTRACT_VERSION; readonly jobId: string; readonly attemptId: string; readonly acceptanceDigest: Hash; readonly skillVersion: string; readonly corpusDigest: Hash; readonly inputRefs: readonly string[]; readonly planDigest: Hash; readonly limits: WorkerLimits; readonly audience: string; readonly expiresAt: number }
export interface WorkerResult { artifactHash: Hash; mediaType: string; artifactRef: string; boundedTrace: string }
export interface DeskRunner extends Adapter { start(spec: WorkerSpec, capability: string): Promise<Result<{ attemptId: string }>>; status(attemptId: string): Promise<Result<{ status: 'queued' | 'running' | 'failed' | 'cancelled' | 'complete'; result?: WorkerResult }>>; cancel(attemptId: string): Promise<Result<void>> }
export interface ReleaseBinding { artifactHash: Hash; mediaType: string; publicDestination: string }
export interface DeskPublisher extends Adapter { publish(claimRef: EntityRef, release: ReleaseBinding, idempotencyKey: string): Promise<Result<Confirmation>>; reconcile(idempotencyKey: string): Promise<Result<Confirmation>> }
export interface PaymentIntent { jobRef: EntityRef; acceptanceRef: EntityRef; chainId: string; payer: Wallet; recipient: Wallet; asset: string; amountAtomic: Decimal; transferInterface: string }
export interface DeskSettlement extends Adapter { prepare(intent: PaymentIntent): Promise<Result<{ chainId: string; transaction: unknown }>>; verify(intent: PaymentIntent, txHash: string): Promise<Result<VerifiedPayment>>; reconcile(intent: PaymentIntent, txHash: string): Promise<Result<VerifiedPayment>> }
export interface Mutation { idempotencyKey: string; expectedRevision: number }
export interface Approval extends Mutation { acceptanceDigest: Hash; skillVersion: string; corpusDigest: Hash; inputRefs: readonly string[]; audience: string; expiresAt: number; limits: WorkerLimits; planDigest: Hash }
export interface ReleaseRequest extends Mutation, ReleaseBinding {}
export interface OperatorJob { id: string; revision: number; publicState: PublicState; execution: 'awaiting_operator' | 'approved' | 'queued' | 'running' | 'review' | 'released' | 'failed' | 'cancelled' | 'expired'; approval?: Approval; result?: WorkerResult }
export interface DeskOperatorApi extends Adapter { inbox(): Promise<Result<OperatorJob[]>>; jobs(): Promise<Result<OperatorJob[]>>; job(id: string): Promise<Result<OperatorJob>>; providers(): Promise<Result<Provider[]>>; approve(id: string, request: Approval): Promise<Result<OperatorJob>>; decline(id: string, request: Mutation): Promise<Result<OperatorJob>>; cancel(id: string, request: Mutation): Promise<Result<OperatorJob>>; preview(id: string): Promise<Result<WorkerResult>>; release(id: string, request: ReleaseRequest): Promise<Result<OperatorJob>> }
export interface DeskClient extends Adapter { discover(): Promise<Result<Observation[]>>; post(job: Job, idempotencyKey: string): Promise<Result<Confirmation>>; offers(jobRef: EntityRef): Promise<Result<Observation[]>>; accept(acceptance: Acceptance, idempotencyKey: string): Promise<Result<Confirmation>>; inspect(jobRef: EntityRef): Promise<Result<PublicState>>; preparePayment(intent: PaymentIntent): Promise<Result<{ chainId: string; transaction: unknown }>>; independentRead(jobRef: EntityRef): Promise<Result<Observation[]>> }
