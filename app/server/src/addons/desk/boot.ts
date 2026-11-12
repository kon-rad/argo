import { query, withTransaction } from '../../db.js';

export interface DeskBootSettings {
  domain?: string; chainId?: string; paymentInterface?: string; usdcAddress?: string;
  rpcUrl?: string; publicOrigin?: string; runtimeModule?: string;
}
export interface DeskBoot { public: unknown; operator: unknown }
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
  });
}
