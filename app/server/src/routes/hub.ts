import type { Router } from 'express';
import { allowlistProxy, type ProxyOptions } from './proxy.js';

/**
 * The Agents page's live half: the kanban board, Claude Code task logs and chats, and the Telegram/default-agent
 * toggle. This server is sandboxed (read-only home, no new privileges), so it can't run `hermes kanban`, start
 * Claude or touch systemd. agent-hub (argo-exo/agents/agent-hub, user hermes, 127.0.0.1 only) does those, and this
 * router forwards an allowlist of its routes with the hub's bearer token, which never reaches the browser.
 * On the Mac there is no hub: every route answers 503.
 */
export type HubOptions = ProxyOptions;

const TASK = 't_[0-9a-f]{6,32}';
const CHAT = '[0-9a-f]{12}';
const ALLOWED: [string, RegExp][] = [
  ['GET', /^\/telegram$/],
  ['POST', /^\/telegram$/],
  ['GET', /^\/agents$/],
  ['GET', /^\/boards$/],
  ['GET', /^\/board$/],
  ['POST', /^\/tasks$/],
  ['GET', new RegExp(`^/tasks/${TASK}$`)],
  ['GET', new RegExp(`^/tasks/${TASK}/log$`)],
  ['POST', new RegExp(`^/tasks/${TASK}/comment$`)],
  ['POST', new RegExp(`^/tasks/${TASK}/assign$`)],
  ['GET', /^\/chats$/],
  ['POST', /^\/chats$/],
  ['GET', new RegExp(`^/chats/${CHAT}/events$`)],
  ['POST', new RegExp(`^/chats/${CHAT}/messages$`)],
  ['POST', new RegExp(`^/chats/${CHAT}/interrupt$`)],
];
const QUERY_KEYS = new Set(['board', 'offset']);

export function hubRouter(opts: HubOptions): Router {
  return allowlistProxy(opts, {
    name: 'agent-hub',
    allowed: ALLOWED,
    queryKeys: QUERY_KEYS,
    unconfigured: 'Agents run on the droplet: agent-hub is not configured on this machine',
  });
}
