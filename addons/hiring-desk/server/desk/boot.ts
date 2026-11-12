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

export interface DeskBootSettings {
  domain?: string; chainId?: string; paymentInterface?: string; usdcAddress?: string;
  rpcUrl?: string; publicOrigin?: string; runtimeModule?: string;
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
  createDeskRuntime(context: { domain: string; persistence: PgDeskPersistence }): Promise<DeskHostRuntime> | DeskHostRuntime;
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
    // Keep the rest of the server available while this optional addon is being
    // configured. Its routes return an explicit 503 until trusted adapters exist.
    const runtimeUnconfigured = [raw.domain, raw.chainId, raw.paymentInterface, raw.rpcUrl, raw.runtimeModule]
      .every(value => value === undefined || value === '');
    if (runtimeUnconfigured) {
      console.warn('Hiring Desk is enabled but not configured; its API will return 503.');
      return undefined;
    }
    throw new Error(`Desk production configuration missing or invalid: ${parsed.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  }
  const settings = parsed.data;
  const runtimeModule = await load(pathToFileURL(settings.runtimeModule).href);
  if (typeof runtimeModule.createDeskRuntime !== 'function') throw new Error('Desk runtime module must export createDeskRuntime with real production services');
  if (!database) throw new Error('Hiring Desk requires the host database adapter.');
  const persistence = new PgDeskPersistence(database.transact, database.query);
  const host = await runtimeModule.createDeskRuntime({ domain: settings.domain, persistence });
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
