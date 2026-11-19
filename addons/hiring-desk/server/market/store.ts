import { randomUUID } from 'node:crypto';
import { CybaError, type CybaArtifact, type CybaJob, type CybaProfile, type CybaPublication, type CybaStore, type NewCybaJob } from './types.js';
export type MarketQuery = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => Promise<{
    rows: T[];
    rowCount: number | null;
}>;
export interface MarketDatabase {
    query: MarketQuery;
    transact<T>(fn: (query: MarketQuery) => Promise<T>): Promise<T>;
}
export const BASE_TOKEN = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
type Row = Record<string, unknown>;
function iso(value: unknown): string { return value instanceof Date ? value.toISOString() : String(value); }
const nullable = (value: unknown): string | null => value == null ? null : String(value);
function job(row: Row): CybaJob {
    return {
        id: String(row.id), clientWallet: String(row.client_wallet), providerId: String(row.provider_id), title: String(row.title), brief: String(row.brief), requestKey: String(row.request_key),
        priceAtomic: String(row.price_atomic), recipient: String(row.recipient), chainId: 8453, tokenAddress: String(row.token_address), status: row.status as CybaJob['status'],
        cardId: nullable(row.card_id), artifactSha256: nullable(row.artifact_sha256), artifactPath: nullable(row.artifact_path), summary: nullable(row.summary), uploadState: row.upload_state as CybaJob['uploadState'], paymentTx: nullable(row.payment_tx), pendingPaymentTx: nullable(row.pending_payment_tx), swarmRef: nullable(row.swarm_ref), releasedAt: row.released_at == null ? null : iso(row.released_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    };
}
function profile(row: Row): CybaProfile { return { id: String(row.id), name: String(row.name), serviceTitle: String(row.service_title), description: String(row.description), priceAtomic: String(row.price_atomic), payoutWallet: String(row.payout_wallet), ensName: String(row.ens_name), agentId: String(row.agent_id), identityBound: row.identity_bound === true }; }
function publication(row: Row): CybaPublication { return { id: String(row.id), jobId: String(row.job_id), kind: String(row.kind), idempotencyKey: String(row.idempotency_key), payload: row.payload as Record<string, unknown>, state: row.state as CybaPublication['state'], reference: nullable(row.reference) }; }
function stable(value: unknown): string { if (Array.isArray(value))
    return '[' + value.map(stable).join(',') + ']'; if (value && typeof value === 'object')
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable((value as Row)[k])).join(',') + '}'; return JSON.stringify(value); }
function requireState(row: CybaJob, states: CybaJob['status'][]): void { if (!states.includes(row.status))
    throw new CybaError(409, 'Job is not in the required state.'); }
/** Every state transition locks one durable job; accepted terms are copied from the trusted profile. */
export class PgCybaStore implements CybaStore {
    constructor(private readonly db: MarketDatabase) { }
    async listProfiles(): Promise<CybaProfile[]> { return (await this.db.query('SELECT * FROM cyba_profiles WHERE identity_bound=true ORDER BY id')).rows.map(profile); }
    async getProfile(id: string): Promise<CybaProfile | undefined> { const row = (await this.db.query('SELECT * FROM cyba_profiles WHERE id=$1', [id])).rows[0]; return row ? profile(row) : undefined; }
    async configureProfile(value: CybaProfile): Promise<void> {
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value.id) || (!/^[1-9][0-9]{0,77}$/.test(value.priceAtomic) || BigInt(value.priceAtomic) >= (1n << 256n)) || (!/^0x[0-9a-fA-F]{40}$/.test(value.payoutWallet) || /^0x0{40}$/i.test(value.payoutWallet)) || !value.ensName || !value.agentId)
            throw new CybaError(400, 'Invalid configured provider.');
        await this.db.query('INSERT INTO cyba_profiles(id,name,service_title,description,price_atomic,payout_wallet,ens_name,agent_id,identity_bound) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET name=$2,service_title=$3,description=$4,price_atomic=$5,payout_wallet=$6,ens_name=$7,agent_id=$8,identity_bound=$9', [value.id, value.name, value.serviceTitle, value.description, value.priceAtomic, value.payoutWallet.toLowerCase(), value.ensName, value.agentId, value.identityBound]);
    }
    async createJob(wallet: string, input: NewCybaJob): Promise<CybaJob> {
        if ((!/^0x[0-9a-fA-F]{40}$/.test(wallet) || /^0x0{40}$/i.test(wallet)) || !/^[A-Za-z0-9._:-]{8,200}$/.test(input.requestKey) || !input.title.trim() || input.title.length > 200 || !input.brief.trim() || input.brief.length > 10000)
            throw new CybaError(400, 'Invalid job request.');
        return this.db.transact(async (q) => {
            const p = (await q('SELECT * FROM cyba_profiles WHERE id=$1 AND identity_bound=true FOR SHARE', [input.providerId])).rows[0];
            if (!p || !/^[1-9][0-9]{0,77}$/.test(String(p.price_atomic)) || BigInt(String(p.price_atomic)) >= (1n << 256n) || /^0x0{40}$/i.test(String(p.payout_wallet)))
                throw new CybaError(503, 'Provider identity or immutable terms are unavailable.');
            await q('INSERT INTO cyba_jobs(id,client_wallet,provider_id,title,brief,request_key,price_atomic,recipient,chain_id,token_address,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,8453,$9,\'triage\') ON CONFLICT(request_key) DO NOTHING', [randomUUID(), wallet.toLowerCase(), input.providerId, input.title.trim(), input.brief.trim(), input.requestKey, String(p.price_atomic), String(p.payout_wallet), BASE_TOKEN]);
            const row = (await q('SELECT * FROM cyba_jobs WHERE request_key=$1 FOR UPDATE', [input.requestKey])).rows[0];
            if (!row)
                throw new CybaError(503, 'Job could not be stored.');
            const current = job(row);
            if (current.clientWallet !== wallet.toLowerCase() || current.providerId !== input.providerId || current.title !== input.title.trim() || current.brief !== input.brief.trim())
                throw new CybaError(409, 'Request key is already bound to different inputs.');
            return current;
        });
    }
    async getJob(id: string): Promise<CybaJob | undefined> { const row = (await this.db.query('SELECT * FROM cyba_jobs WHERE id=$1', [id])).rows[0]; return row ? job(row) : undefined; }
    async listJobs(wallet?: string): Promise<CybaJob[]> { return (await this.db.query(wallet ? 'SELECT * FROM cyba_jobs WHERE client_wallet=$1 ORDER BY created_at DESC LIMIT 200' : 'SELECT * FROM cyba_jobs ORDER BY created_at DESC LIMIT 200', wallet ? [wallet.toLowerCase()] : [])).rows.map(job); }
    private async mutate(id: string, fn: (current: CybaJob, q: MarketQuery) => Promise<void>): Promise<CybaJob> {
        try {
            return await this.db.transact(async (q) => {
                const row = (await q('SELECT * FROM cyba_jobs WHERE id=$1 FOR UPDATE', [id])).rows[0];
                if (!row)
                    throw new CybaError(404, 'Job not found.');
                await fn(job(row), q);
                return job((await q('SELECT * FROM cyba_jobs WHERE id=$1', [id])).rows[0]!);
            });
        }
        catch (error) {
            if ((error as {
                code?: string;
            }).code === '23505')
                throw new CybaError(409, 'Binding is already allocated to another job.');
            throw error;
        }
    }
    bindCard(id: string, cardId: string): Promise<CybaJob> { return this.mutate(id, async (j, q) => { if (!/^t_[a-f0-9]{6,32}$/.test(cardId) || (j.cardId && j.cardId !== cardId))
        throw new CybaError(409, 'Conflicting card binding.'); await q('UPDATE cyba_jobs SET card_id=$2,updated_at=now() WHERE id=$1', [id, cardId]); }); }
    approveJob(id: string): Promise<CybaJob> { return this.mutate(id, async (j, q) => { requireState(j, ['triage', 'active']); if (!j.cardId)
        throw new CybaError(409, 'Job has no board card.'); await q('UPDATE cyba_jobs SET status=\'active\',updated_at=now() WHERE id=$1', [id]); }); }
    stageArtifact(id: string, artifact: CybaArtifact): Promise<CybaJob> { return this.mutate(id, async (j, q) => { requireState(j, ['active', 'review']); if (!/^[0-9a-f]{64}$/.test(artifact.sha256) || !artifact.path || !artifact.summary.trim() || artifact.summary.length > 4000)
        throw new CybaError(400, 'Invalid reviewed artifact.'); await q('UPDATE cyba_jobs SET status=\'review\',artifact_path=$2,artifact_sha256=$3,summary=$4,updated_at=now() WHERE id=$1', [id, artifact.path, artifact.sha256, artifact.summary]); }); }
    releaseJob(id: string, sha256: string, expectedSummary: string): Promise<CybaJob> { return this.mutate(id, async (j, q) => { requireState(j, ['review', 'released', 'paid']); if (j.artifactSha256 !== sha256 || !j.artifactPath || !j.summary || j.summary !== expectedSummary)
        throw new CybaError(409, 'Reviewed artifact has changed.'); if (j.status === 'review')
        await q('UPDATE cyba_jobs SET status=\'released\',released_at=now(),updated_at=now() WHERE id=$1', [id]); }); }
    cancelJob(id: string): Promise<CybaJob> { return this.mutate(id, async (j, q) => { if (j.paymentTx || j.pendingPaymentTx)
        throw new CybaError(409, 'Confirmed payment requires delivery reconciliation.'); requireState(j, ['triage', 'active', 'review', 'released', 'cancelled']); await q('UPDATE cyba_jobs SET status=\'cancelled\',updated_at=now() WHERE id=$1', [id]); }); }
    rememberPendingPayment(id: string, txHash: string): Promise<CybaJob> { return this.mutate(id, async (j, q) => { requireState(j, ['released', 'paid']); const hash = txHash.toLowerCase(); if (!/^0x[0-9a-f]{64}$/.test(hash) || (j.pendingPaymentTx && j.pendingPaymentTx !== hash) || (j.paymentTx && j.paymentTx !== hash))
        throw new CybaError(409, 'Another payment is being reconciled.'); await q('UPDATE cyba_jobs SET pending_payment_tx=$2,updated_at=now() WHERE id=$1', [id, hash]); }); }
    clearPendingPayment(id: string, txHash: string): Promise<CybaJob> { return this.mutate(id, async (j, q) => { if (j.paymentTx || (j.pendingPaymentTx && j.pendingPaymentTx !== txHash.toLowerCase()))
        throw new CybaError(409, 'Payment checkpoint cannot be cleared.'); await q('UPDATE cyba_jobs SET pending_payment_tx=NULL,updated_at=now() WHERE id=$1', [id]); }); }
    reservePayment(id: string, txHash: string): Promise<CybaJob> { return this.mutate(id, async (j, q) => { requireState(j, ['released', 'paid']); if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) || (j.paymentTx && j.paymentTx !== txHash.toLowerCase()) || (j.pendingPaymentTx && j.pendingPaymentTx !== txHash.toLowerCase()))
        throw new CybaError(409, 'Conflicting payment binding.'); await q('UPDATE cyba_jobs SET payment_tx=$2,pending_payment_tx=NULL,updated_at=now() WHERE id=$1', [id, txHash.toLowerCase()]); }); }
    async beginUpload(id: string): Promise<{
        job: CybaJob;
        started: boolean;
    }> { let started = false; const current = await this.mutate(id, async (j, q) => { requireState(j, ['released', 'paid']); if (!j.paymentTx)
        throw new CybaError(409, 'Payment is not confirmed.'); if (j.uploadState === 'not-started') {
        await q('UPDATE cyba_jobs SET upload_state=\'uploading\',updated_at=now() WHERE id=$1', [id]);
        started = true;
    } }); return { job: current, started }; }
    checkpointSwarm(id: string, ref: string): Promise<CybaJob> { return this.mutate(id, async (j, q) => { requireState(j, ['released', 'paid']); if (!j.paymentTx || !/^swarm:\/\/[0-9a-f]{64}$/.test(ref) || (j.swarmRef && j.swarmRef !== ref))
        throw new CybaError(409, 'Invalid paid delivery checkpoint.'); await q('UPDATE cyba_jobs SET swarm_ref=$2,upload_state=\'uploaded\',updated_at=now() WHERE id=$1', [id, ref]); }); }
    completeDelivery(id: string, ref: string): Promise<CybaJob> { return this.mutate(id, async (j, q) => { requireState(j, ['released', 'paid']); if (!j.paymentTx || j.swarmRef !== ref)
        throw new CybaError(409, 'Paid delivery is not checkpointed.'); await q('UPDATE cyba_jobs SET status=\'paid\',updated_at=now() WHERE id=$1', [id]); }); }
    async enqueuePublication(jobId: string, kind: string, payload: Record<string, unknown>): Promise<CybaPublication> {
        return this.db.transact(async (q) => {
            const row = (await q('SELECT * FROM cyba_jobs WHERE id=$1 FOR UPDATE', [jobId])).rows[0];
            if (!row)
                throw new CybaError(404, 'Job not found.');
            const j = job(row);
            if (!['job-accepted', 'owner-approved', 'released-hash', 'verified-payment', 'paid-delivery'].includes(kind) || (payload.swarmRef && (kind !== 'paid-delivery' || !j.paymentTx || payload.swarmRef !== j.swarmRef)) || (kind === 'paid-delivery' && (!j.paymentTx || !j.swarmRef)))
                throw new CybaError(409, 'Publication state is not authorized.');
            const key = kind + ':' + jobId;
            await q('INSERT INTO cyba_publications(id,job_id,kind,idempotency_key,payload) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(idempotency_key) DO NOTHING', [randomUUID(), jobId, kind, key, JSON.stringify(payload)]);
            const saved = (await q('SELECT * FROM cyba_publications WHERE idempotency_key=$1', [key])).rows[0]!;
            if (stable(saved.payload) !== stable(payload))
                throw new CybaError(409, 'Publication key is already bound to other bytes.');
            return publication(saved);
        });
    }
    async confirmedPublications(jobId: string): Promise<string[]> { return (await this.db.query('SELECT reference FROM cyba_publications WHERE job_id=$1 AND state=\'confirmed\' ORDER BY created_at,id', [jobId])).rows.map(r => String(r.reference)); }
    async pendingPublications(jobId: string): Promise<CybaPublication[]> { return (await this.db.query('SELECT * FROM cyba_publications WHERE job_id=$1 AND state=\'pending\' ORDER BY created_at,id', [jobId])).rows.map(publication); }
    async confirmPublication(id: string, reference: string): Promise<void> { if (!reference || reference.length > 500)
        throw new CybaError(400, 'Invalid publication reference.'); const result = await this.db.query('UPDATE cyba_publications SET state=\'confirmed\',reference=$2 WHERE id=$1 AND (reference IS NULL OR reference=$2) RETURNING id', [id, reference]); if (!result.rows.length)
        throw new CybaError(409, 'Publication reference conflicts.'); }
    async reservePublication(key: string, digest: string, event: Record<string, unknown>): Promise<{
        kind: 'acquired';
    } | {
        kind: 'busy';
    } | {
        kind: 'uncertain';
    } | {
        kind: 'existing';
        ref?: string;
    }> {
        if (key !== String(event.kind) + ':' + String(event.jobId) || !/^[0-9a-f]{64}$/.test(digest))
            throw new CybaError(400, 'Invalid publication lease.');
        await this.enqueuePublication(String(event.jobId), String(event.kind), event);
        return this.db.transact(async (q) => {
            const row = (await q('SELECT *, (lease_until>now()) AS lease_active FROM cyba_publications WHERE idempotency_key=$1 FOR UPDATE', [key])).rows[0]!;
            if (row.event_digest && row.event_digest !== digest)
                throw new CybaError(409, 'Publication digest conflicts.');
            if (row.state === 'confirmed')
                return { kind: 'existing', ref: String(row.reference) };
            if (row.lease_active === true)
                return { kind: 'busy' };
            if (row.write_started === true)
                return { kind: 'uncertain' };
            await q('UPDATE cyba_publications SET event_digest=$2,write_started=true,lease_until=now()+interval \'2 minutes\' WHERE idempotency_key=$1', [key, digest]);
            return { kind: 'acquired' };
        });
    }
    async recordPublication(key: string, digest: string, ref: string): Promise<void> {
        if (!ref || ref.length > 500)
            throw new CybaError(400, 'Invalid publication reference.');
        const result = await this.db.query('UPDATE cyba_publications SET state=\'confirmed\',reference=$3,lease_until=NULL WHERE idempotency_key=$1 AND event_digest=$2 AND (reference IS NULL OR reference=$3) RETURNING id', [key, digest, ref]);
        if (!result.rows.length)
            throw new CybaError(409, 'Publication checkpoint conflicts.');
    }
    async abortBeforeWrite(key: string, digest: string): Promise<void> { await this.db.query('UPDATE cyba_publications SET lease_until=NULL,write_started=false WHERE idempotency_key=$1 AND event_digest=$2 AND state=\'pending\' AND lease_until>now()', [key, digest]); }
    async retryPublication(key: string, digest: string): Promise<void> { await this.db.query('UPDATE cyba_publications SET lease_until=NULL WHERE idempotency_key=$1 AND event_digest=$2 AND state=\'pending\'', [key, digest]); }
}
