import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, type UsageMessage } from '../../lib/api.js';
import { formatTokens } from './format.js';

function FullRecord({ id }: { id: number }) {
  const [open, setOpen] = useState(false);
  const full = useQuery({ queryKey: ['usage-message', id], queryFn: () => api.usageMessage(id), enabled: open });
  if (!open) return <button type="button" className="text-xs underline" onClick={() => setOpen(true)}>Show full record</button>;
  return <pre className="mt-1 max-h-[60vh] overflow-auto whitespace-pre-wrap text-xs">{full.data ? JSON.stringify(full.data.raw, null, 2) : 'Loading…'}</pre>;
}

function Message({ m }: { m: UsageMessage }) {
  const folded = m.text.startsWith('[thinking]') || m.text.startsWith('[tool_use') || m.kind === 'tool_result';
  const body = <pre className="whitespace-pre-wrap break-words text-sm">{m.text}</pre>;
  return (
    <div className={`border-t border-[var(--rule)] py-2 ${m.is_sidechain ? 'ml-6' : ''}`}>
      <div className="flex flex-wrap gap-2 text-xs text-[var(--ink-dim)]">
        <span className="font-semibold text-[var(--ink)]">{m.role}</span>
        {m.ts && <span>{new Date(m.ts).toLocaleString()}</span>}
        {m.is_sidechain && <span>subagent</span>}
        {m.call && (
          <span className="rounded bg-[var(--paper-sunk)] px-1">
            {m.call.model} · in {formatTokens(m.call.input)} · cache w {formatTokens(m.call.cache_write)} · cache r {formatTokens(m.call.cache_read)} · out {formatTokens(m.call.output)}{m.call.action ? ` · ${m.call.action}${m.call.tool ? ` (${m.call.tool})` : ''}` : ''}
          </span>
        )}
      </div>
      {folded ? <details><summary className="cursor-pointer text-xs">{m.text.slice(0, 80)}</summary>{body}</details> : body}
      {m.truncated && <div className="text-xs text-[var(--ink-dim)]">Showing 20,000 of {m.length.toLocaleString()} characters. <FullRecord id={m.id} /></div>}
    </div>
  );
}

export default function UsageSession() {
  const { host = '', externalId = '' } = useParams();
  const [params] = useSearchParams();
  const source = params.get('source') ?? 'claude-code';
  const q = useQuery({ queryKey: ['usage-session', host, externalId, source], queryFn: () => api.usageSession(host, externalId, source) });
  if (q.isPending) return <div className="p-4 text-[var(--ink-dim)]">Loading…</div>;
  if (q.isError) return <div className="p-4">Could not load this session: {(q.error as Error).message}</div>;
  const { session: s, run, messages } = q.data;
  const runs = q.data.runs?.length ? q.data.runs : run ? [run] : [];
  return (
    <div className="h-full overflow-auto break-words p-4">
      <Link to="/usage" className="text-xs underline">Back to Usage</Link>
      <h1 className="mt-1 text-lg font-semibold">{s.title ?? s.external_id}</h1>
      <div className="text-xs text-[var(--ink-dim)]">
        {s.source} on {s.host} · {s.calls} calls · in {formatTokens(Number(s.input))} · cache w {formatTokens(Number(s.cache_write))} ·
        cache r {formatTokens(Number(s.cache_read))} · out {formatTokens(Number(s.output))}
        {s.source === 'hermes' && s.cost_usd !== null && s.cost_usd !== undefined && ` · ${Number(s.cost_usd).toFixed(2)} USD`}
      </div>
      {runs.map((run) => (
        <div key={run.run_id ?? run.session_id} className="mt-2 rounded border border-[var(--rule)] p-2 text-sm">
          {run.agent_name
            ? <><Link className="underline" to={`/org/agents/${run.agent_name}`}>{run.agent_name}</Link>{run.reason ? ` woken by ${run.reason}` : ''}{run.task_id ? <> on card <Link className="underline" to={`/agents/board/${run.task_id}`}>{run.task_id}</Link></> : ''}</>
            : <>Task {run.task_id ?? '?'} on {run.lane ?? '?'}</>}
          {run.project_slug ? ` · ${run.project_slug}${run.feature_slug ? `/${run.feature_slug}` : ''}` : ''}{run.work_type ? ` · ${run.work_type}` : ''}
          {' '}· {run.num_turns ?? '?'} turns · {run.subtype ?? ''}
          {run.started_at ? ` · ${new Date(run.started_at).toLocaleString()}` : ''}
          {run.calls != null ? ` · ${run.calls} calls, out ${formatTokens(Number(run.output ?? 0))}` : ''}
          {run.verify_name && (
            <details><summary>Verify {run.verify_name}: {run.verify_passed ? 'passed' : 'failed'}{run.verify_metric != null ? ` (${run.verify_metric})` : ''}</summary>
              <pre className="whitespace-pre-wrap text-xs">{run.verify_output}</pre></details>
          )}
        </div>
      ))}
      {messages.length === 0 && <p className="mt-3 text-sm text-[var(--ink-dim)]">Token counts only: this transcript's text is not on this server (sessions from before the push went live are in the Mac app and B2).</p>}
      <div className="mt-3">{messages.map((m) => <Message key={m.id} m={m} />)}</div>
    </div>
  );
}
