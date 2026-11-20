export type CybaStatus = 'triage' | 'active' | 'review' | 'released' | 'paid' | 'cancelled';
export interface CybaProfile {
    id: string;
    name: string;
    serviceTitle: string;
    description: string;
    priceAtomic: string;
    payoutWallet: string;
    ensName: string;
    agentId: string;
    identityBound: boolean;
}
export interface CybaJob {
    id: string;
    clientWallet: string;
    providerId: string;
    title: string;
    brief: string;
    requestKey: string;
    priceAtomic: string;
    recipient: string;
    chainId: 8453;
    tokenAddress: string;
    status: CybaStatus;
    cardId: string | null;
    artifactSha256: string | null;
    artifactPath: string | null;
    summary: string | null;
    uploadState: 'not-started' | 'uploading' | 'uploaded';
    paymentTx: string | null;
    pendingPaymentTx: string | null;
    swarmRef: string | null;
    releasedAt: string | null;
    createdAt: string;
    updatedAt: string;
}
export interface PublicJob {
    id: string;
    providerId: string;
    title: string;
    priceAtomic: string;
    status: CybaStatus;
    summary: string | null;
    artifactSha256: string | null;
    paymentTx?: string;
    downloadRef?: string;
    deliveryPending?: boolean;
    pendingPaymentTx?: string;
    evidenceRefs?: string[];
}
export interface CybaPaymentTerms {
    chainId: 8453;
    tokenAddress: string;
    sender: string;
    recipient: string;
    amountAtomic: string;
    jobId: string;
}
export interface NewCybaJob {
    providerId: string;
    title: string;
    brief: string;
    requestKey: string;
}
export interface CybaArtifact {
    path: string;
    sha256: string;
    summary: string;
}
export interface CybaPublication {
    id: string;
    jobId: string;
    kind: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    state: 'pending' | 'confirmed';
    reference: string | null;
}
export interface CybaStore {
    listProfiles(): Promise<CybaProfile[]>;
    getProfile(id: string): Promise<CybaProfile | undefined>;
    createJob(wallet: string, input: NewCybaJob): Promise<CybaJob>;
    getJob(id: string): Promise<CybaJob | undefined>;
    listJobs(wallet?: string): Promise<CybaJob[]>;
    bindCard(id: string, cardId: string): Promise<CybaJob>;
    approveJob(id: string): Promise<CybaJob>;
    stageArtifact(id: string, artifact: CybaArtifact): Promise<CybaJob>;
    releaseJob(id: string, sha256: string, expectedSummary: string): Promise<CybaJob>;
    cancelJob(id: string): Promise<CybaJob>;
    rememberPendingPayment(id: string, txHash: string): Promise<CybaJob>;
    clearPendingPayment(id: string, txHash: string): Promise<CybaJob>;
    reservePayment(id: string, txHash: string): Promise<CybaJob>;
    beginUpload(id: string): Promise<{
        job: CybaJob;
        started: boolean;
    }>;
    checkpointSwarm(id: string, ref: string): Promise<CybaJob>;
    completeDelivery(id: string, ref: string): Promise<CybaJob>;
    enqueuePublication(jobId: string, kind: string, payload: Record<string, unknown>): Promise<CybaPublication>;
    confirmedPublications(jobId: string): Promise<string[]>;
    pendingPublications(jobId: string): Promise<CybaPublication[]>;
    confirmPublication(id: string, reference: string): Promise<void>;
    reservePublication(key: string, digest: string, event: Record<string, unknown>): Promise<{
        kind: 'acquired';
    } | {
        kind: 'busy';
    } | {
        kind: 'uncertain';
    } | {
        kind: 'existing';
        ref?: string;
    }>;
    recordPublication(key: string, digest: string, ref: string): Promise<void>;
    abortBeforeWrite(key: string, digest: string): Promise<void>;
    retryPublication(key: string, digest: string): Promise<void>;
}
/** Handlers never serialize storage rows. A paid receipt alone does not imply delivery is ready. */
export function publicJob(job: CybaJob): PublicJob {
    return {
        id: job.id, providerId: job.providerId, title: job.title, priceAtomic: job.priceAtomic, status: job.status,
        summary: ['released', 'paid'].includes(job.status) ? job.summary : null,
        artifactSha256: ['released', 'paid'].includes(job.status) ? job.artifactSha256 : null,
        ...(job.pendingPaymentTx && !job.paymentTx ? { pendingPaymentTx: job.pendingPaymentTx } : {}),
        ...(job.paymentTx ? { paymentTx: job.paymentTx } : {}),
        ...(job.status === 'paid' && job.swarmRef ? { downloadRef: job.swarmRef } : {}),
        ...(job.paymentTx && !(job.status === 'paid' && job.swarmRef) ? { deliveryPending: true } : {}),
    };
}
export function paymentTerms(job: CybaJob): CybaPaymentTerms {
    return { chainId: job.chainId, tokenAddress: job.tokenAddress, sender: job.clientWallet, recipient: job.recipient, amountAtomic: job.priceAtomic, jobId: job.id };
}
export class CybaError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
}
