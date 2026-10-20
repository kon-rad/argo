import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Points Claude Code at the capture proxy through `env.ANTHROPIC_BASE_URL` in the user's
 * ~/.claude/settings.json, and takes it away again. Only ever touches that one key, and
 * only when its value is the proxy's own URL: a gateway someone set by hand is left alone.
 * New Claude Code sessions read it at start; running ones keep what they started with.
 */
export const claudeSettingsPath = (home = homedir()): string => join(home, '.claude', 'settings.json');
export const proxyUrl = (port: number): string => `http://127.0.0.1:${port}`;

type Settings = { env?: Record<string, string>; [k: string]: unknown };

function read(path: string): Settings {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Settings) : {};
}
function write(path: string, s: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(s, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
}

export type RouteState = 'proxy' | 'direct' | 'other';

/** 'proxy': Claude Code goes through us; 'direct': no base URL set; 'other': someone else's gateway. */
export function routeState(port: number, path = claudeSettingsPath()): RouteState {
  const v = read(path).env?.ANTHROPIC_BASE_URL;
  return !v ? 'direct' : v === proxyUrl(port) ? 'proxy' : 'other';
}

export function routeThroughProxy(port: number, path = claudeSettingsPath()): RouteState {
  const s = read(path);
  const v = s.env?.ANTHROPIC_BASE_URL;
  if (v && v !== proxyUrl(port)) return 'other';
  if (v === proxyUrl(port)) return 'proxy';
  write(path, { ...s, env: { ...(s.env ?? {}), ANTHROPIC_BASE_URL: proxyUrl(port) } });
  return 'proxy';
}

export function routeDirect(port: number, path = claudeSettingsPath()): RouteState {
  const s = read(path);
  if (s.env?.ANTHROPIC_BASE_URL !== proxyUrl(port)) return routeState(port, path);
  const { ANTHROPIC_BASE_URL: _gone, ...env } = s.env;
  const next: Settings = { ...s, env };
  if (!Object.keys(env).length) delete next.env;
  write(path, next);
  return 'direct';
}

/**
 * Fail-open, run by every scheduled `ledger run`: two failed health checks in a row take
 * Claude Code off the proxy so new sessions go straight to the API; a healthy proxy puts
 * it back. `failures` is the caller's persisted counter.
 */
export async function watchProxy(port: number, failures: number, path = claudeSettingsPath(),
  check: () => Promise<boolean> = () => fetch(`${proxyUrl(port)}/__ledger/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false),
): Promise<{ healthy: boolean; failures: number; route: RouteState; changed: boolean }> {
  const before = routeState(port, path);
  if (await check()) {
    const route = before === 'direct' ? routeThroughProxy(port, path) : before;
    return { healthy: true, failures: 0, route, changed: route !== before };
  }
  const n = failures + 1;
  const route = n >= 2 && before === 'proxy' ? routeDirect(port, path) : before;
  return { healthy: false, failures: n, route, changed: route !== before };
}
