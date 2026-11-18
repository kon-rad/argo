import { useQuery } from '@tanstack/react-query';
import { zoned, ago } from '../../lib/time.js';
import DataTable from '../../components/DataTable.js';
import { skillsApi, type HostState } from './api.js';
import { Chip, Digest, Empty, ErrorState, Loading } from './ui.js';

const HOST_TONE: Record<HostState['status'], 'ok' | 'warn' | 'bad' | 'dim'> = {
  current: 'ok', drift: 'warn', dirty: 'warn', stale: 'warn', never: 'dim', failed: 'bad',
};
const HOST_LABEL: Record<HostState['status'], string> = {
  current: 'up to date', drift: 'differs from policy', dirty: 'locally modified', stale: 'not heard from recently', never: 'never acknowledged', failed: 'last sync failed',
};

/** Desired versus acknowledged skill packages per machine. Only what machines reported; nothing assumed from a push. */
export default function Machines() {
  const m = useQuery({ queryKey: ['skills', 'machines'], queryFn: skillsApi.machines });
  if (m.isPending) return <Loading what="machines" />;
  if (m.isError) return <ErrorState error={m.error} retry={() => void m.refetch()} />;
  const data = m.data;
  return (
    <div className="space-y-3 p-3 md:p-4">
      <p className="text-sm text-[var(--ink-dim)]">
        A machine counts as up to date only after it runs a sync and acknowledges the package digests it installed. Pushing to Git is not a sync.
        A machine that never acknowledged is unknown, and one silent for more than {data.staleAfterHours} hours is marked stale.
      </p>
      {data.notes.length > 0 && <ul className="list-disc pl-5 text-xs text-[var(--ink-dim)]">{data.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {data.hosts.length === 0 ? (
        <Empty>No machines yet. Run <code>secondbrain skills sync</code> on a machine with a device token to see it here.</Empty>
      ) : (
        <ul className="space-y-3">
          {data.hosts.map((h) => (
            <li key={h.host} className="rounded border border-[var(--rule)] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold">{h.display}</h2>
                <code className="text-xs text-[var(--ink-dim)]">{h.host}</code>
                <Chip tone={HOST_TONE[h.status]}>{HOST_LABEL[h.status]}</Chip>
                <span className="text-xs text-[var(--ink-dim)]">{h.lastAck ? `last acknowledged ${zoned(h.lastAck)} (${ago(h.lastAck)})` : 'never acknowledged'}</span>
              </div>
              {h.views.length === 0 ? <p className="mt-1 text-xs text-[var(--ink-dim)]">No agent views reported.</p> : (
                <ul className="mt-2 space-y-2">
                  {h.views.map((v) => (
                    <li key={`${v.agent}/${v.runtime}`} className="text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{v.agent}</span> on {v.runtime}
                        <Chip tone={v.status === 'current' ? 'ok' : v.status === 'failed' ? 'bad' : 'warn'}>{v.status}</Chip>
                        <span className="text-[var(--ink-dim)]">view <Digest value={v.viewDigest} /> received {zoned(v.receivedAt)}</span>
                      </div>
                      {v.error && <p role="alert" className="text-[var(--warn)]">{v.error}</p>}
                      {v.dirty.length > 0 && <p className="text-amber-700 dark:text-amber-400">Modified on the machine: {v.dirty.join(', ')}</p>}
                      {v.missing.length > 0 && (
                        <ul className="text-amber-700 dark:text-amber-400">
                          {v.missing.map((r) => <li key={r.skill}>{r.skill} is missing {[...r.bins.map((b) => `program ${b}`), ...r.env.map((e) => `setting ${e}`)].join(', ')}</li>)}
                        </ul>
                      )}
                      {v.skills.length > 0 && (
                        <div className="mt-1">
                          <DataTable label={`${v.agent} on ${v.runtime}`} phone="cards" className="text-left">
                            <thead className="text-[var(--ink-dim)]"><tr><th className="pr-3">Skill</th><th className="pr-3">Wanted</th><th className="pr-3">Installed</th><th>State</th></tr></thead>
                            <tbody>
                              {v.skills.map((s) => (
                                <tr key={s.name}>
                                  <td className="pr-3">{s.name}</td><td className="pr-3"><Digest value={s.desired} /></td><td className="pr-3"><Digest value={s.observed} /></td>
                                  <td><Chip tone={s.state === 'match' ? 'ok' : s.state === 'unknown' ? 'dim' : 'warn'}>{s.state}</Chip></td>
                                </tr>
                              ))}
                            </tbody>
                          </DataTable>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
