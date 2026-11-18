import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';

export default function CollectionHealth() {
  const q = useQuery({ queryKey: ['usage-health'], queryFn: api.usageHealth, refetchInterval: 60_000, retry: false });
  const when = (s?: string | null) => s ? new Date(s).toLocaleString() : 'unknown';
  return <details className="shrink-0 border-b border-[var(--rule)] px-4 py-2 text-xs">
    <summary>Session collection {q.isError ? 'unavailable' : q.data?.streams?.length ? `· ${q.data.streams?.length} streams` : '· unknown'}</summary>
    {q.isError ? <p role="alert">Collection health did not load.</p> : !q.data?.streams?.length ? <p>No reporting streams. Configure expected streams to detect missing collectors.</p> :
      <ul>{q.data.streams.map(s => <li key={JSON.stringify([s.host, s.collector_instance, s.runtime, s.path])} className="py-1 break-all">
        <strong>{s.host} / {s.runtime}</strong> · {s.path} · {s.state}<br />
        Last attempt {when(s.ended_at)} · received {when(s.received_at)} · last success {when(s.last_success_at)} · backlog {s.backlog ?? 'unknown'}
        {s.reason ? ` · error ${s.reason}` : ''}
      </li>)}</ul>}
  </details>;
}
