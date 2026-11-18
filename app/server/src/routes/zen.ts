import type { Router } from 'express';
import { allowlistProxy, type ProxyOptions } from './proxy.js';

/**
 * Chats with zen-agent: `zen-agent serve` (zen-agent/src/serve.ts) keeps one live agent per open chat and an event log
 * per chat (every trace line plus text and thinking deltas), on loopback with a bearer token. This router forwards its
 * routes under /api/zen, the same way hub.ts forwards agent-hub's: the app server never runs an agent itself. Point
 * ZEN_AGENT_URL at the serve process (or at anything that forwards `/zen/*` to it, such as an agent-hub).
 */
export type ZenOptions = ProxyOptions;

const CHAT = '[0-9a-f]{12}';
const ALLOWED: [string, RegExp][] = [
  ['GET', /^\/models$/],
  ['GET', /^\/personas$/],
  ['GET', /^\/skills$/],
  ['GET', /^\/chats$/],
  ['POST', /^\/chats$/],
  ['GET', new RegExp(`^/chats/${CHAT}$`)],
  ['GET', new RegExp(`^/chats/${CHAT}/events$`)],
  ['POST', new RegExp(`^/chats/${CHAT}/messages$`)],
  ['POST', new RegExp(`^/chats/${CHAT}/steer$`)],
  ['POST', new RegExp(`^/chats/${CHAT}/interrupt$`)],
];
const QUERY_KEYS = new Set(['offset']);

export function zenRouter(opts: ZenOptions): Router {
  return allowlistProxy(opts, {
    name: 'zen-agent',
    allowed: ALLOWED,
    queryKeys: QUERY_KEYS,
    prefix: '/zen',
    unconfigured: 'zen-agent chats run on the server: zen-agent serve is not configured on this machine (ZEN_AGENT_URL, ZEN_AGENT_TOKEN)',
  });
}
