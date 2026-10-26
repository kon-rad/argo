import type { Router } from 'express';
import { allowlistProxy, type ProxyOptions } from './proxy.js';

/**
 * The Agents page's live half: Claude Code chats and the Telegram/default-agent toggle. The board is not here (it is
 * the engine's own, /api/board). This server is sandboxed (read-only home, no new privileges), so it can't start
 * Claude or touch systemd. agent-hub (argo-exo/agents/agent-hub, 127.0.0.1 only) does those, and this
 * router forwards an allowlist of its routes with the hub's bearer token, which never reaches the browser.
 * On the Mac there is no hub: every route answers 503.
 */
export type HubOptions = ProxyOptions;

const CHAT = '[0-9a-f]{12}';
const ALLOWED: [string, RegExp][] = [
  ['GET', /^\/telegram$/],
  ['POST', /^\/telegram$/],
  ['GET', /^\/chats$/],
  ['POST', /^\/chats$/],
  ['GET', new RegExp(`^/chats/${CHAT}/events$`)],
  ['POST', new RegExp(`^/chats/${CHAT}/messages$`)],
  ['POST', new RegExp(`^/chats/${CHAT}/interrupt$`)],
];
const QUERY_KEYS = new Set(['offset']);

export function hubRouter(opts: HubOptions): Router {
  return allowlistProxy(opts, {
    name: 'agent-hub',
    allowed: ALLOWED,
    queryKeys: QUERY_KEYS,
    unconfigured: 'Agents run on the droplet: agent-hub is not configured on this machine',
  });
}
