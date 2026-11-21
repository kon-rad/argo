import type { Assignment, Target } from './types.js';

export type LauncherKind = Exclude<Target['kind'], 'org-agent'>;
export interface Observation {
  assignment: Assignment;
  version: number;
  healthy: boolean;
  activePollers?: number;
  selectedPollerHealthy?: boolean;
}

/** Implemented by reviewed host code. All four methods must have bounded deadlines.
 * apply atomically fences its version, including retries after a controller crash.
 * Route adapters recheck the selected poller at cutover and preserve the old healthy route on failure.
 */
export interface LauncherAdapter {
  inspect(): Promise<Observation>;
  preflight(desired: Assignment): Promise<boolean>;
  apply(version: number, desired: Assignment): Promise<void>;
  verify(version: number, desired: Assignment): Promise<Observation>;
}

export function sameAssignment(a: Assignment, b: Assignment) {
  return a.runtime === b.runtime && a.model === b.model && a.provider === b.provider;
}

export function ready(kind: LauncherKind, state: Observation) {
  return state.healthy === true && Number.isSafeInteger(state.version) && state.version >= 0
    && (kind !== 'telegram-poller' || state.activePollers === 1)
    && (kind !== 'default-route' || state.selectedPollerHealthy === true);
}

export async function runLauncher(kind: LauncherKind, version: number, desired: Assignment, adapter?: LauncherAdapter, previous?: Assignment) {
  if (!adapter) return 'unsupported';
  try {
    const state = await adapter.inspect();
    if (state.version > version) return 'stale';
    if (previous && !sameAssignment(state.assignment,previous) && !sameAssignment(state.assignment,desired)) return 'drifted';
    if (!ready(kind,state) || !await adapter.preflight(desired)) return 'unhealthy';
    if (state.version !== version || !sameAssignment(state.assignment,desired)) await adapter.apply(version,desired);
    const actual = await adapter.verify(version,desired);
    return ready(kind,actual) && actual.version === version && sameAssignment(actual.assignment,desired) ? 'verified' : 'unhealthy';
  } catch {
    // A service exception can contain secrets. Keep diagnostics on the controller host.
    return 'failed';
  }
}
