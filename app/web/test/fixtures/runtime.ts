const base = { runtime: 'codex', model: 'base-model', provider: null };
const effective = { ...base, model: 'effective-model' };
const proposed = { ...base, model: 'next-model' };
export const runtimeTargets = [
  { kind: 'org-agent', id: 'guide', configured: base, effective, health: 'not-probed', adapter: 'org-next-claim',
    lastObserved: { runtime: 'codex', model: 'observed-model', started_at: '2026-01-01T12:00:00Z' } },
  ...['cron-job', 'telegram-gateway', 'telegram-poller', 'default-route'].map(kind => ({
    kind, id: kind === 'default-route' ? 'main' : 'unregistered', configured: base, effective: base,
    health: 'unsupported', adapter: null, lastObserved: null,
  })),
];
const profile = { id: 'standard', version: 2, definition: { name: 'Standard', default: proposed, exceptions: {}, capabilities: {} } };
export const runtimeStatus = { desiredVersion: 0, profiles: [profile], profileRevisions: [profile], targets: runtimeTargets, history: [], receipts: [] };
export function runtimePreview(scoped: boolean, expired = false) {
  const targets = scoped ? runtimeTargets.slice(0, 1) : runtimeTargets;
  return { token: 'reviewed-token', profileId: profile.id, profileVersion: 2, rosterVersion: 'revision',
    expiresAt: new Date(Date.now() + (expired ? -1 : 60000)).toISOString(),
    changes: targets.map(({ kind, id, effective: from, adapter, health }) => ({
      target: { kind, id }, from, to: proposed, adapter, health,
      problem: adapter ? null : kind === 'default-route' ? 'Default poller inactive' : 'unsupported: no registered launcher adapter',
    })),
    uncovered: runtimeTargets.slice(targets.length).map(({ kind, id }) => ({ kind, id })),
    inFlight: [{ id: 123, agent_name: 'guide', runtime: 'codex' }],
  };
}
