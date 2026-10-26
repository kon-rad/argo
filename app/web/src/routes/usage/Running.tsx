import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type RunningRow } from '../../lib/api.js';

/** `3 m 12 s`, `2 h 05 m`, `4 d 3 h`. */
export function elapsedText(sec: number | null): string {
  if (sec === null) return '';
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${String(m).padStart(2, '0')} m`;
  return m ? `${m} m ${String(s).padStart(2, '0')} s` : `${s} s`;
}

const KIND_LABEL: Record<RunningRow['kind'], string> = { bot: 'Bots', lane: 'Lane workers', other: 'Other agent sessions' };
const KIND_HINT: Record<RunningRow['kind'], string> = {
  bot: 'A named org agent on a wake: a card, a DM, a mention or a handoff.',
  lane: 'A cc-dispatcher worker on a kanban card, not tied to a named bot.',
  other: 'Agent processes that belong to no roster entry: scheduled cron runs, Remote Control, interactive sessions, zen-agent serve.',
};

function Group({ kind, rows }: { kind: RunningRow['kind']; rows: RunningRow[] }) {
  if (!rows.length) return null;
  return (
    <section>
      <h2 className="text-sm font-semibold">{KIND_LABEL[kind]} <span className="font-normal text-[var(--ink-dim)]">({rows.length})</span></h2>
      <p className="text-xs text-[var(--ink-dim)]">{KIND_HINT[kind]}</p>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead className="text-left text-xs text-[var(--ink-dim)]"><tr>
          <th>{kind === 'other' ? 'Session' : 'Name'}</th><th>Runtime</th><th>Model</th><th>Woken by</th><th className="text-right">Running</th><th className="text-right">PID</th><th>Run</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => {
            // The roster says one thing and the process is another: a flip that has not taken effect yet, or a run that started before it.
            const drift = r.configured && r.configured.runtime !== r.runtime && r.runtime !== 'unknown';
            return (
              <tr key={`${r.pid ?? r.runId ?? i}-${i}`} className="border-t border-[var(--rule)] align-top">
                <td>
                  {r.kind === 'bot' ? <Link className="hover:underline" to={`/usage?agent=${encodeURIComponent(r.name)}`}>{r.name}</Link> : r.name}
                  {r.state === 'claimed' && <span className="ml-1 rounded bg-[var(--paper-sunk)] px-1 text-xs text-[var(--ink-dim)]" title={r.detail ?? ''}>claimed, no process</span>}
                </td>
                <td>
                  {r.runtime}
                  {drift && <span className="ml-1 text-xs text-[var(--ink-dim)]" title="The roster now says a different runtime; this run started under the old one and finishes there.">roster: {r.configured!.runtime}</span>}
                </td>
                <td className="max-w-[16rem] truncate" title={r.model ?? ''}>{r.model ?? '-'}</td>
                <td>{r.reason ? `${r.reason}${r.ref ? ` ${r.ref}` : ''}` : '-'}</td>
                <td className="text-right tabular-nums" title={r.startedAt ? `since ${new Date(r.startedAt).toLocaleString()}` : ''}>{elapsedText(r.elapsedSec)}</td>
                <td className="text-right tabular-nums text-[var(--ink-dim)]">{r.pid ?? ''}</td>
                <td className="font-mono text-xs text-[var(--ink-dim)]">{r.runId ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
    </section>
  );
}

export default function Running() {
  const q = useQuery({ queryKey: ['usage-running'], queryFn: () => api.usageRunning(), refetchInterval: 10_000 });
  const rows = q.data?.rows ?? [];
  const by = (k: RunningRow['kind']) => rows.filter((r) => r.kind === k);
  const cfg = Object.entries(q.data?.configured ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-4">
      <div className="text-xs text-[var(--ink-dim)]">
        {q.data ? <>Processes on <span className="font-mono">{q.data.host}</span>, read {new Date(q.data.at).toLocaleTimeString()}. Refreshes every 10 s.</> : 'Loading...'}
        {cfg.length > 0 && <> Roster: {cfg.map(([rt, n]) => `${n} on ${rt}`).join(', ')}.</>}
      </div>
      {q.isError && <div className="text-sm text-red-600">The running list did not load.</div>}
      {q.data && rows.length === 0 && <div className="text-sm text-[var(--ink-dim)]">No agent is running right now.</div>}
      <Group kind="bot" rows={by('bot')} />
      <Group kind="lane" rows={by('lane')} />
      <Group kind="other" rows={by('other')} />
    </div>
  );
}
