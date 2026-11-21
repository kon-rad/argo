import { query, withTransaction } from '../../db.js';
import { assignCard, BoardError, createCard, getCard, moveCard } from '../../board.js';
import { config } from '../../config.js';

export interface DeskBootSettings {
  domain?: string; chainId?: string; paymentInterface?: string; usdcAddress?: string;
  rpcUrl?: string; publicOrigin?: string; runtimeModule?: string;
  arkivRpcUrl?: string; arkivChainId?: string; arkivPrivateKey?: string; arkivLifetimeBlocks?: string;
  beeUrl?: string; beePostageBatchId?: string; identityRpcUrl?: string; identityChainId?: string;
  ensRpcUrl?: string; ensChainId?: string; erc8004RegistryAddress?: string; metadataHosts?: string;
  timeoutMs?: string; maxResponseBytes?: string; maxArtifactBytes?: string; publicationDestination?: string;
  marketEnabled?: string; marketEnvelopeSecret?: string; marketArtifactRoot?: string;
  marketBaseRpcUrl?: string; marketProfiles?: string; marketExecutionAgent?: string;
  cybazaarApiOrigin?: string; cybazaarIntegrationSecret?: string;
}
export interface DeskBoot { public?: unknown; operator?: unknown; market?: unknown; marketplace?: unknown }
type ExternalRoutes = (context: unknown) => unknown[];
interface HiringDeskPackage {
  bootDesk(modules: ReadonlySet<string>, settings: DeskBootSettings, load: undefined, database: unknown): Promise<DeskBoot | undefined>;
  routes: ExternalRoutes;
}

let externalRoutes: ExternalRoutes | undefined;
const packageName = '@secondbrain/hiring-desk/server';

export function loadedDeskRoutes(): ExternalRoutes | undefined { return externalRoutes; }

export async function bootDesk(modules: ReadonlySet<string>, settings: DeskBootSettings): Promise<DeskBoot | undefined> {
  if (!modules.has('desk')) return undefined;
  let addon: HiringDeskPackage;
  try {
    addon = await import(packageName) as HiringDeskPackage;
  } catch (error) {
    throw new Error(`Hiring desk is enabled but ${packageName} is not installed. Run npm install ${packageName} in app, rebuild, and run secondbrain doctor.`, { cause: error });
  }
  externalRoutes = addon.routes;
  return addon.bootDesk(modules, settings, undefined, {
    query,
    transact: <T>(fn: (run: typeof query) => Promise<T>) => withTransaction(client => fn(client.query as typeof query)),
    marketBoard: {
      get: async (id: string) => {
        try { return (await getCard(id)).card; }
        catch (error) { if (error instanceof BoardError && error.status === 404) return null; throw error; }
      },
      create: async (input: { id: string; title: string; body: string; contract: { cybazaarJobId: string } | { cybazaarRequestId: string }; assignee: null }) => {
        try { return await createCard(config.orgOwner, { ...input, board: 'exo', kind: 'work' }); }
        catch (error) {
          const db = error as { code?: string; constraint?: string };
          if ((db.code === '23505' && db.constraint === 'cards_pkey') || (error instanceof BoardError && error.message === `card ${input.id} exists`)) return (await getCard(input.id)).card;
          throw error;
        }
      },
      assign: (id: string, agent: string) => assignCard(config.orgOwner, id, agent),
      move: (id: string, status: string) => moveCard(config.orgOwner, id, status),
    },
  });
}
