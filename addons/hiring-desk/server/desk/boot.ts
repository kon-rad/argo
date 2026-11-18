import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { assertProductionAdapters, digest } from '@secondbrain/desk-contracts/desk';
import type { DeskSettlement } from '@secondbrain/desk-contracts/desk';
import { DeskOrchestrator, type DeskServiceOptions } from './orchestration/service.js';
import { PgDeskPersistence, type DeskPersistence } from './persistence/store.js';
import { ArcNativeUsdcSettlement, ARC_NATIVE_USDC_INTERFACE, ARC_TESTNET_CHAIN_ID } from './settlement/arc.js';
import { ArcErc20UsdcSettlement, ARC_ERC20_USDC_INTERFACE, ARC_TESTNET_USDC_ADDRESS } from './settlement/arc-erc20.js';
import { ArcJsonRpcReader } from './settlement/rpc.js';
import type { DeskPublicControls } from './routes.js';
import type { DeskPrivateControls } from './operator/routes.js';
import { createCybazaarBackend, cybazaarConfigSchema, type CybazaarOperationalDependencies } from './runtime.js';

export interface DeskBootSettings {
  domain?: string; chainId?: string; paymentInterface?: string; usdcAddress?: string;
  rpcUrl?: string; publicOrigin?: string; runtimeModule?: string;
  arkivRpcUrl?: string; arkivChainId?: string; arkivPrivateKey?: string; arkivLifetimeBlocks?: string;
  beeUrl?: string; beePostageBatchId?: string; identityRpcUrl?: string; identityChainId?: string;
  ensRpcUrl?: string; ensChainId?: string;
  erc8004RegistryAddress?: string; metadataHosts?: string; timeoutMs?: string; maxResponseBytes?: string;
  maxArtifactBytes?: string; publicationDestination?: string;
}
const settingsSchema = z.object({
  domain: z.string().min(1).max(200),
  chainId: z.literal(ARC_TESTNET_CHAIN_ID),
  paymentInterface: z.enum([ARC_ERC20_USDC_INTERFACE, ARC_NATIVE_USDC_INTERFACE]),
  usdcAddress: z.string().optional(),
  rpcUrl: z.url().refine(value => ['https:', 'http:'].includes(new URL(value).protocol)),
  publicOrigin: z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password; }),
  runtimeModule: z.string().min(1).refine(isAbsolute, 'DESK_RUNTIME_MODULE must be an absolute server-side module path'),
}).superRefine((value, ctx) => {
  if (value.paymentInterface === ARC_ERC20_USDC_INTERFACE && value.usdcAddress?.toLowerCase() !== ARC_TESTNET_USDC_ADDRESS) ctx.addIssue({ code: 'custom', path: ['usdcAddress'], message: 'ERC-20 settlement requires the verified Arc Testnet USDC contract' });
});

/** The host supplies real identity/marketplace/worker services, never browser input. */
export type DeskHostRuntime = Omit<DeskServiceOptions, 'store' | 'settlement'>;
export interface DeskRuntimeModule {
  createDeskRuntime?(context: { domain: string; persistence: PgDeskPersistence }): Promise<DeskHostRuntime> | DeskHostRuntime;
  createCybazaarDependencies?(context: { domain: string; persistence: PgDeskPersistence }): Promise<CybazaarOperationalDependencies> | CybazaarOperationalDependencies;
}
export interface DeskBoot { public: DeskPublicControls; operator: DeskPrivateControls }
type Query = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>;
export interface DeskDatabase {
  query: Query;
  transact<T>(fn: (query: Query) => Promise<T>): Promise<T>;
}

/** This validates capabilities and marks no integration as live merely because it exists. */
export function assertLiveDeskHost(host: DeskHostRuntime): void {
  assertProductionAdapters('production', [host.snapshots, host.publicStore, host.identity, host.runner, host.publisher, host.providerTransactions, host.capabilities]);
  const methods = [
    [host.snapshots, ['snapshot']], [host.publicStore, ['listJobs', 'get', 'publish', 'confirmation']],
    [host.identity, ['profile', 'resolve']], [host.runner, ['start', 'status', 'cancel']],
    [host.publisher, ['publish', 'reconcile']], [host.providerTransactions, ['prepareClaim', 'prepareDelivery']],
    [host.capabilities, ['issue', 'revoke']],
  ] as const;
  for (const [adapter, names] of methods) for (const name of names) {
    if (typeof (adapter as unknown as Record<string, unknown>)[name] !== 'function') throw new Error('Desk runtime is missing a production adapter operation');
  }
  if (typeof host.artifactBytes !== 'function' || typeof host.eligibleProviders !== 'function') throw new Error('Desk runtime is missing trusted artifact or provider services');
}

/** Receipt allocation is unavailable before delivery or after accepted bindings change. */
export async function reserveReleasedReceipt(persistence: Pick<DeskPersistence, 'get' | 'reservePayment'>, receiptId: string, assignmentKey: string): Promise<boolean> {
  const [jobRef, acceptanceRef, extra] = assignmentKey.split('\u0000');
  if (!jobRef || !acceptanceRef || extra !== undefined) return false;
  const row = await persistence.get(jobRef);
  if (!row || row.execution !== 'released' || row.publicState.conflict || row.publicState.acceptanceRef !== acceptanceRef) return false;
  const state = row.publicState;
  if (!state.delivery || !state.acceptance || !state.offer || !state.job || !state.acceptanceDigest || !row.approval) return false;
  if (state.acceptance.jobRef !== jobRef || state.offer.jobRef !== jobRef || state.acceptance.offerRef !== state.offerRef || state.acceptance.client !== state.job.client) return false;
  if (await digest('acceptance', state.acceptance) !== state.acceptanceDigest || row.approval.acceptanceDigest !== state.acceptanceDigest || row.approval.skillVersion !== state.offer.skillVersion || await digest('offer-terms', state.offer) !== state.acceptance.offerDigest) return false;
  return persistence.reservePayment(jobRef, receiptId);
}

/** Called before listen, and never imports or validates desk settings when disabled. */
export async function bootDesk(
  modules: ReadonlySet<string>,
  raw: DeskBootSettings,
  load: (url: string) => Promise<DeskRuntimeModule> = url => import(url) as Promise<DeskRuntimeModule>,
  database?: DeskDatabase,
): Promise<DeskBoot | undefined> {
  if (!modules.has('desk')) return undefined;
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    // Development may keep the rest of the server available while this optional
    // addon is being configured. Production always fails closed before listen.
    const runtimeUnconfigured = [raw.domain, raw.chainId, raw.paymentInterface, raw.rpcUrl, raw.runtimeModule]
      .every(value => value === undefined || value === '');
    if (runtimeUnconfigured && process.env.NODE_ENV !== 'production') {
      console.warn('Hiring Desk is enabled but not configured; its API will return 503.');
      return undefined;
    }
    throw new Error(`Desk production configuration missing or invalid: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  }
  const settings = parsed.data;
  const runtimeModule = await load(pathToFileURL(settings.runtimeModule).href);
  const hasConcreteHint = [raw.arkivRpcUrl, raw.arkivChainId, raw.arkivPrivateKey, raw.beeUrl, raw.beePostageBatchId, raw.identityRpcUrl].some(value => value !== undefined);
  if (!hasConcreteHint && typeof runtimeModule.createDeskRuntime !== 'function') throw new Error('Desk runtime module must export createDeskRuntime with real production services');
  if (!database) throw new Error('Hiring Desk requires the host database adapter.');
  const persistence = new PgDeskPersistence(database.transact, database.query);
  const rawCybazaar = {
    arkivRpcUrl: raw.arkivRpcUrl, arkivChainId: raw.arkivChainId, arkivPrivateKey: raw.arkivPrivateKey,
    arkivLifetimeBlocks: raw.arkivLifetimeBlocks, beeUrl: raw.beeUrl, beePostageBatchId: raw.beePostageBatchId,
    identityRpcUrl: raw.identityRpcUrl, identityChainId: raw.identityChainId, ensRpcUrl: raw.ensRpcUrl, ensChainId: raw.ensChainId, erc8004RegistryAddress: raw.erc8004RegistryAddress,
    metadataHosts: raw.metadataHosts?.split(',').map(value => value.trim()).filter(Boolean), timeoutMs: raw.timeoutMs,
    maxResponseBytes: raw.maxResponseBytes, maxArtifactBytes: raw.maxArtifactBytes, publicationDestination: raw.publicationDestination,
  };
  const configured = Object.values(rawCybazaar).some(value => value !== undefined);
  if (process.env.NODE_ENV === 'production' && !configured) throw new Error('Desk production configuration missing concrete Arkiv, Swarm, signer, and identity settings');
  let host: DeskHostRuntime;
  if (configured) {
    const concrete = cybazaarConfigSchema.safeParse(rawCybazaar);
    if (!concrete.success) throw new Error(`Desk production configuration missing or invalid: ${concrete.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
    if (typeof runtimeModule.createCybazaarDependencies !== 'function') throw new Error('Desk runtime module must export createCybazaarDependencies for operational worker services');
    const operational = await runtimeModule.createCybazaarDependencies({ domain: settings.domain, persistence });
    host = createCybazaarBackend({ domain: settings.domain, config: concrete.data, persistence, publicationQuery: database.query, operational });
  } else {
    if (typeof runtimeModule.createDeskRuntime !== 'function') throw new Error('Desk runtime module must export createDeskRuntime with real production services');
    host = await runtimeModule.createDeskRuntime({ domain: settings.domain, persistence });
  }
  assertLiveDeskHost(host);
  const reader = new ArcJsonRpcReader(settings.rpcUrl);
  const reserve = (receiptId: string, assignmentKey: string) => reserveReleasedReceipt(persistence, receiptId, assignmentKey);
  const settlement: DeskSettlement = settings.paymentInterface === ARC_ERC20_USDC_INTERFACE
    ? new ArcErc20UsdcSettlement({ usdcAddress: settings.usdcAddress!, reader, reserve })
    : new ArcNativeUsdcSettlement(reader, reserve);
  const orchestrator = new DeskOrchestrator({ ...host, store: persistence, settlement });
  return {
    public: {
      store: host.publicStore, identity: host.identity, settlement, snapshots: host.snapshots, paymentReader: reader,
      persistence, orchestrator, publicOrigin: settings.publicOrigin,
      payment: { chainId: settings.chainId, interfaceId: settings.paymentInterface, tokenAddress: settings.usdcAddress ?? '' },
    },
    operator: orchestrator,
  };
}
