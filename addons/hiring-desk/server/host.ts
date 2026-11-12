import type { Express, RequestHandler, Router } from 'express';
import type { DeskBoot } from './desk/boot.js';

export interface DeskRouteContext {
  app: Express;
  sessionGate?: RequestHandler;
  opts: { desk?: DeskBoot };
}

export interface DeskRoute { path: string; router: Router; mount?: 'raw' | 'public' | 'session' }
export type DeskRoutes = (context: DeskRouteContext) => DeskRoute[];
