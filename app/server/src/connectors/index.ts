import { embeddingsConnector } from '../embeddings/embed.js';
import { vaultConnector } from './vault/scan.js';
import type { Connector } from './types.js';

/** Keyed by `sources.kind`; stats are opaque to the runner. */
export type ConnectorRegistry = Record<string, Connector<unknown>>;

/** Keyed by `sources.kind`. Discord joins this map in phase 2. */
export const connectors: ConnectorRegistry = {
  vault: vaultConnector,
  embeddings: embeddingsConnector,
};


