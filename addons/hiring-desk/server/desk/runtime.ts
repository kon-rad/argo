import { z } from 'zod';
import type { DeskRecord, Provider, ReleaseBinding, Result } from '@secondbrain/desk-contracts/desk';
import { ServerArkivDeskClient } from '@secondbrain/desk-arkiv/server';
import { ConfiguredDeskIdentity } from './identity/identity.js';
import { RpcErc8004Reader } from './identity/erc8004.js';
import type { EnsResolver, ProviderProfileConfig } from './identity/types.js';
import type { DeskHostRuntime } from './boot.js';
import type { CapabilityIssuer, ProviderTransactionIntents } from './orchestration/service.js';
import { ArkivDeskPublicStore, ArkivDeskSnapshots } from './public-store/arkiv.js';
import { PgPublicationLedger } from './publishing/ledger.js';
import { BeeHttpSwarmGateway, ReviewedSwarmPublisher, SwarmRequestDeskStore } from './publishing/swarm.js';
import type { DeskPersistence, PgDeskPersistence } from './persistence/store.js';

const httpsUrl = z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; });
export const cybazaarConfigSchema = z.object({
  arkivRpcUrl: httpsUrl,
  arkivChainId: z.coerce.number().int().positive(),
  arkivPrivateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  arkivLifetimeBlocks: z.coerce.number().int().min(1).max(1_296_000),
  beeUrl: z.url().refine(value => { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1') && !url.username && !url.password && !url.search && !url.hash; }),
  beePostageBatchId: z.string().regex(/^[0-9a-fA-F]{64}$/),
  identityRpcUrl: httpsUrl,
  identityChainId: z.string().regex(/^[1-9][0-9]*$/),
  ensRpcUrl: httpsUrl,
  ensChainId: z.string().regex(/^[1-9][0-9]*$/),
  erc8004RegistryAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  metadataHosts: z.array(z.string()).max(32),
  timeoutMs: z.coerce.number().int().min(100).max(30_000),
  maxResponseBytes: z.coerce.number().int().min(4096).max(4_000_000),
  maxArtifactBytes: z.coerce.number().int().min(1).max(10_000_000),
  publicationDestination: z.literal('swarm://'),
}).strict();
export type CybazaarConfig = z.infer<typeof cybazaarConfigSchema>;

export interface CybazaarOperationalDependencies {
  providers: readonly ProviderProfileConfig[];
  ens: EnsResolver & { readonly rpcUrl: string; readonly chainId: string };
  runner: DeskHostRuntime['runner'];
  providerTransactions: ProviderTransactionIntents;
  capabilities: CapabilityIssuer;
  eligibleProviders(): Promise<Result<Provider[]>>;
  artifactBytes(ref: string): Promise<Uint8Array>;
}

function sameRelease(a: { artifactHash: string; mediaType: string; publicDestination: string }, b: typeof a): boolean {
  return a.artifactHash === b.artifactHash && a.mediaType === b.mediaType && a.publicDestination === b.publicDestination;
}

/** Concrete privileged composition. Only operational worker controls stay injected. */
export function createCybazaarBackend(input: {
  domain: string;
  config: CybazaarConfig;
  persistence: PgDeskPersistence;
  publicationQuery: ConstructorParameters<typeof PgPublicationLedger>[0];
  operational: CybazaarOperationalDependencies;
  fetcher?: typeof fetch;
  arkivClient?: ConstructorParameters<typeof ArkivDeskPublicStore>[0]['client'];
}): DeskHostRuntime {
  const config = cybazaarConfigSchema.parse(input.config);
  if (input.operational.ens.rpcUrl !== config.ensRpcUrl || input.operational.ens.chainId !== config.ensChainId) throw new Error('ENS resolver does not match the configured endpoint and chain');
  const arkivClient = input.arkivClient ?? new ServerArkivDeskClient({
    rpcUrl: config.arkivRpcUrl, domain: input.domain, chainId: config.arkivChainId,
    privateKey: config.arkivPrivateKey, lifetimeBlocks: config.arkivLifetimeBlocks,
    timeoutMs: config.timeoutMs, maxResponseBytes: config.maxResponseBytes,
  });
  const chainId = `arkiv:${config.arkivChainId}`;
  const publicStore = new ArkivDeskPublicStore({ domain: input.domain, chainId, client: arkivClient });
  const snapshots = new ArkivDeskSnapshots(publicStore);
  const identity = new ConfiguredDeskIdentity({
    mode: 'live', providers: input.operational.providers, ens: input.operational.ens,
    erc8004: new RpcErc8004Reader({ rpcUrl: config.identityRpcUrl, chainId: config.identityChainId,
      registryAddress: config.erc8004RegistryAddress, metadataHosts: config.metadataHosts,
      timeoutMs: config.timeoutMs, maxMetadataBytes: Math.min(config.maxResponseBytes, 262_144) }),
  });
  const ledger = new PgPublicationLedger(input.publicationQuery);
  const rows = async (store: DeskPersistence) => store.list();
  const authorization = { verify: async (claimRef: string, release: ReleaseBinding, key: string) =>
    (await rows(input.persistence)).some(row => row.backendPublication?.claimRef === claimRef && row.backendPublication.idempotencyKey === key && sameRelease(row.backendPublication.release, release)) };
  const artifacts = { read: async (release: ReleaseBinding) => {
    const row = (await rows(input.persistence)).find(value => value.backendPublication && sameRelease(value.backendPublication.release, release) && value.result?.artifactHash === release.artifactHash && value.result.mediaType === release.mediaType);
    if (!row?.result) throw new Error('Approved publication artifact is unavailable');
    return input.operational.artifactBytes(row.result.artifactRef);
  } };
  const claims = { provider: async (claimRef: string) => {
    const observed = await publicStore.get(claimRef);
    if (observed.kind !== 'ok' || (observed.value.record as DeskRecord).type !== 'claim') throw new Error('Verified claim is unavailable');
    return (observed.value.record as Extract<DeskRecord, { type: 'claim' }>).provider;
  } };
  const swarm = new BeeHttpSwarmGateway(config.beeUrl, config.beePostageBatchId, input.fetcher, config.timeoutMs, config.maxArtifactBytes);
  const signerStore = new SwarmRequestDeskStore(publicStore, swarm);
  const publisher = new ReviewedSwarmPublisher({
    swarm, ledger, store: signerStore, authorization, artifacts, claims, domain: input.domain, chainId, destination: config.publicationDestination,
  });
  const backendSigner = 'signerAddress' in arkivClient && typeof arkivClient.signerAddress === 'function' ? arkivClient.signerAddress() : undefined;
  if (!backendSigner) throw new Error('Cybazaar Arkiv client must expose its configured signer address');
  return {
    snapshots, publicStore: signerStore, identity, publisher, runner: input.operational.runner,
    providerTransactions: input.operational.providerTransactions, capabilities: input.operational.capabilities,
    eligibleProviders: input.operational.eligibleProviders, artifactBytes: input.operational.artifactBytes, backendSigner,
  };
}
