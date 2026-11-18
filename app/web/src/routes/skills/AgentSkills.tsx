import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { zoned } from '../../lib/time.js';
import { skillsApi } from './api.js';
import { Chip, Empty, ErrorState, Loading, Reasons, StateChip } from './ui.js';

/** One agent's skills: what the policy gives it and why, its runtime's limits, and what was seen loaded. */
export default function AgentSkills() {
  const { agent = '' } = useParams();
  const page = useQuery({ queryKey: ['skills', 'agent', agent], queryFn: () => skillsApi.agent(agent) });
  if (page.isPending) return <Loading what={`${agent}'s skills`} />;
  if (page.isError) return <ErrorState error={page.error} retry={() => void page.refetch()} />;
  const { agent: a, cells, notes, mode } = page.data;
  const shown = cells.filter((c) => c.state !== 'not-assigned' || c.reference || c.loaded);
  return (
    <div className="space-y-3 p-3 md:p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold tracking-tight">{a.name}</h1>
        <span className="text-sm text-[var(--ink-dim)]">{a.team ?? 'no team'} · {a.runtime}</span>
        <Chip tone={a.support === 'catalog-filtered' ? 'ok' : 'warn'} title={a.supportNote}>{a.support}</Chip>
        <Link className="text-sm text-[var(--accent)]" to={`/skills/matrix?agent=${encodeURIComponent(a.name)}`}>In the matrix</Link>
        <Link className="text-sm text-[var(--accent)]" to={`/org/agents/${encodeURIComponent(a.name)}`}>Profile</Link>
      </header>
      <p className="text-sm text-[var(--ink-dim)]">{a.supportNote}</p>
      {mode === 'legacy' && <p className="text-sm"><Chip tone="accent">No managed policy</Chip> This agent sees every skill its runtime finds, as before.</p>}
      {notes.length > 0 && <ul className="list-disc pl-5 text-xs text-[var(--ink-dim)]">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      <p className="text-xs text-[var(--ink-dim)]">{a.assigned} assigned · {a.references} named in knowledge</p>
      {shown.length === 0 ? <Empty>No skill is assigned to, denied for or referenced by {a.name}.</Empty> : (
        <ul className="space-y-2">
          {shown.map((c) => (
            <li key={c.skill} className="rounded border border-[var(--rule)] p-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Link className="font-medium text-[var(--accent)]" to={`/skills/s/${encodeURIComponent(c.skill)}`}>{c.skill}</Link>
                <StateChip state={c.state} />
                {c.deprecated && <Chip tone="warn">deprecated</Chip>}
                {c.reference && <Chip>named in knowledge, not a grant</Chip>}
                <span className="text-xs text-[var(--ink-dim)]">{c.loaded ? `loaded ${zoned(c.loaded.at)} (${c.loaded.source})` : 'No load recorded'}</span>
              </div>
              <div className="mt-1"><Reasons reasons={c.reasons} /></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
