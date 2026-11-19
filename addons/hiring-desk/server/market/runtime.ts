import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ServerCybaArkivTransport } from '@secondbrain/desk-arkiv/cybazaar';
import { RpcErc8004Reader } from '../desk/identity/erc8004.js';
import type { EnsResolver } from '../desk/identity/types.js';
import { BeeHttpSwarmGateway } from '../desk/publishing/swarm.js';
import { TrustedMp4Artifacts } from './artifacts.js';
import { createBaseRpc } from './base-payment.js';
import { CybaBoardBridge, type MarketBoardAdapter } from './board.js';
import { MarketDelivery } from './delivery.js';
import { PgCybaStore, type MarketDatabase } from './store.js';
import type { MarketControls } from './routes.js';
import type { CybaProfile } from './types.js';
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(x => !/^0x0{40}$/i.test(x));
const https = z.url().refine(x => { const u = new URL(x); return u.protocol === 'https:' && !u.username && !u.password && !u.hash; });
const profileSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), name: z.string().min(1).max(200), serviceTitle: z.string().min(1).max(200), description: z.string().max(4000), priceAtomic: z.string().regex(/^[1-9][0-9]{0,77}$/).refine(x => BigInt(x) < (1n << 256n)), payoutWallet: address, ownerWallet: address, ensName: z.string().min(1).max(255), agentId: z.string().regex(/^(0|[1-9][0-9]*)$/) }).strict();
export const marketConfigSchema = z.object({
    domain: z.string().min(1).max(128), envelopeSecret: z.string().min(32).max(1024), artifactRoot: z.string().refine(isAbsolute), baseRpcUrl: https, executionAgent: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    profiles: z.array(profileSchema).length(1), arkivRpcUrl: https, arkivChainId: z.coerce.number().int().positive(), arkivPrivateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/), arkivLifetimeBlocks: z.coerce.number().int().min(1).max(1296000),
    beeUrl: z.url().refine(x => { const u = new URL(x); return (u.protocol === 'https:' || u.protocol === 'http:' && u.hostname === '127.0.0.1') && !u.username && !u.password && !u.search && !u.hash; }), beePostageBatchId: z.string().regex(/^[0-9a-fA-F]{64}$/),
    identityRpcUrl: https, identityChainId: z.literal('8453'), erc8004RegistryAddress: address, ensRpcUrl: https, ensChainId: z.string().regex(/^[1-9][0-9]*$/), metadataHosts: z.array(z.string()).max(32), timeoutMs: z.coerce.number().int().min(100).max(30000).default(10000), maxResponseBytes: z.coerce.number().int().min(4096).max(4000000).default(262144), maxArtifactBytes: z.coerce.number().int().min(12).max(10000000).default(10000000),
}).strict();
export type MarketConfig = z.infer<typeof marketConfigSchema>;
/** ENS implementation must perform normalized supported resolver reads on this exact configured endpoint. */
export interface MarketOperationalDependencies {
    ens: EnsResolver & {
        rpcUrl: string;
        chainId: string;
    };
}
export function createMarketRuntime(input: {
    config: MarketConfig;
    database: MarketDatabase;
    board: MarketBoardAdapter;
    operational: MarketOperationalDependencies;
}): MarketControls {
    const config = marketConfigSchema.parse(input.config), ens = input.operational.ens;
    if (!ens || ens.rpcUrl !== config.ensRpcUrl || ens.chainId !== config.ensChainId || typeof ens.normalizeName !== 'function' || typeof ens.resolveAddress !== 'function')
        throw new Error('Market ENS resolver does not match configuration');
    const store = new PgCybaStore(input.database), board = new CybaBoardBridge(input.board, config.executionAgent), artifacts = new TrustedMp4Artifacts(config.artifactRoot, config.maxArtifactBytes);
    const rpc = createBaseRpc(config.baseRpcUrl, { timeoutMs: config.timeoutMs, maxResponseBytes: config.maxResponseBytes });
    const swarm = new BeeHttpSwarmGateway(config.beeUrl, config.beePostageBatchId, fetch, config.timeoutMs, config.maxArtifactBytes);
    const transport = new ServerCybaArkivTransport({ rpcUrl: config.arkivRpcUrl, domain: config.domain, chainId: config.arkivChainId, privateKey: config.arkivPrivateKey, lifetimeBlocks: config.arkivLifetimeBlocks, timeoutMs: config.timeoutMs, maxResponseBytes: config.maxResponseBytes });
    const erc = new RpcErc8004Reader({ rpcUrl: config.identityRpcUrl, chainId: config.identityChainId, registryAddress: config.erc8004RegistryAddress, metadataHosts: config.metadataHosts, maxMetadataBytes: Math.min(config.maxResponseBytes, 262144), timeoutMs: config.timeoutMs });
    const ledger = { reservePublication: (key: string, digest: string, event: import('@secondbrain/desk-arkiv/cybazaar').CybaEvent) => store.reservePublication(key, digest, event as unknown as Record<string, unknown>), recordPublication: (key: string, digest: string, ref: string) => store.recordPublication(key, digest, ref), retryPublication: (key: string, digest: string) => store.retryPublication(key, digest), abortBeforeWrite: (key: string, digest: string) => store.abortBeforeWrite(key, digest) };
    const delivery = new MarketDelivery({ store, board, artifacts, rpc, swarm, ledger, transport });
    const verifiedProfiles = async (): Promise<CybaProfile[]> => {
        const verified: CybaProfile[] = [];
        for (const configured of config.profiles) {
            const p: CybaProfile = { id: configured.id, name: configured.name, serviceTitle: configured.serviceTitle, description: configured.description, priceAtomic: configured.priceAtomic, payoutWallet: configured.payoutWallet.toLowerCase(), ensName: configured.ensName, agentId: configured.agentId, identityBound: false };
            // Clear previous verification before any network read. An unavailable reader cannot leave stale listing authority.
            await store.configureProfile(p);
            try {
                const normalized = ens.normalizeName(p.ensName);
                if (normalized !== p.ensName)
                    continue;
                const registration = await erc.readRegistration(`eip155:${config.identityChainId}:${config.erc8004RegistryAddress}/${p.agentId}`);
                const resolved = await ens.resolveAddress(normalized);
                if (!registration || registration.owner.toLowerCase() !== configured.ownerWallet.toLowerCase() || registration.paymentWallet?.toLowerCase() !== p.payoutWallet || resolved?.toLowerCase() !== configured.ownerWallet.toLowerCase())
                    continue;
                p.identityBound = true;
                await store.configureProfile(p);
                verified.push(p);
            }
            catch { /* Fail closed: private errors/RPC bodies never enter public profile data. */ }
        }
        return verified;
    };
    return { store, envelopeSecret: config.envelopeSecret, verifiedProfiles, artifactBytes: job => artifacts.readBound(job.artifactPath!, job.artifactSha256!), actions: {
            ensureCard: async (job) => { await store.bindCard(job.id, await board.ensureCard(job)); await delivery.audit(job, 'job-accepted'); await delivery.flush(job.id); },
            approve: async (job) => { await board.approve(job, config.executionAgent); const approved = await store.approveJob(job.id); await delivery.audit(approved, 'owner-approved'); await delivery.flush(job.id); },
            stage: (job, ref, summary) => delivery.stage(job, ref, summary), release: (job, sha, summary) => delivery.release(job, sha, summary), pay: (job, hash) => delivery.pay(job, hash),
            cancel: async (job) => { if (job.paymentTx || job.pendingPaymentTx)
                throw new Error('Payment reconciliation required'); if (job.cardId)
                await input.board.move(job.cardId, 'archived'); await store.cancelJob(job.id); },
            reconcileDelivery: (job, reference) => delivery.reconcileDelivery(job, reference),
        } };
}
