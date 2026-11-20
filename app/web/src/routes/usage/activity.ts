/** Use recorded instants only. Long sessions open their latest bounded day, at the latest evidence. */
export function activityWindow(session: { id: number; host: string; started_at: string | null; ended_at: string | null }, steps: { ts: string | null }[]) {
  const times = [session.started_at, session.ended_at, ...steps.map(s => s.ts)].flatMap(t => {
    const n = t ? Date.parse(t) : NaN; return Number.isFinite(n) && n >= 0 ? [n] : [];
  });
  if (!times.length) return null;
  const cursor = Math.max(...times), to = cursor + 1, from = Math.max(0, Math.min(...times), to - 86400000);
  return `/observatory?${new URLSearchParams({ from: String(from), to: String(to), cursor: String(cursor), session: String(session.id), host: session.host })}`;
}
