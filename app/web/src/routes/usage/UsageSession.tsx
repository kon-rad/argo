import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, type AgentSessionRun, type AgentStep } from '../../lib/api.js';
import { zoned } from '../../lib/time.js';
import { AgentAvatar } from '../../components/AgentAvatar.js';
import { SessionContent, SessionReferences } from './SessionContent.js';
import { formatTokens } from './format.js';
import { duration, groupTurns, toolSummary, type ToolPair } from './steps.js';

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const SHOW_KEY = 'usage-session-show';
type Show = { thinking: boolean; results: boolean; system: boolean };
const DEFAULT_SHOW: Show = { thinking: false, results: false, system: false };

// A per-viewer convenience: storage can be missing or blocked, and the page works without it.
function loadShow(): Show {
  try { return { ...DEFAULT_SHOW, ...JSON.parse(localStorage.getItem(SHOW_KEY) ?? '{}') }; } catch { return DEFAULT_SHOW; }
}
function saveShow(s: Show): void {
  try { localStorage.setItem(SHOW_KEY, JSON.stringify(s)); } catch { /* not saved; fine */ }
}

const time = (ts: string | null) => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }) : '');

function CallChip({ call }: { call: AgentStep['call'] }) {
  if (!call) return null;
  return (
    <span className="rounded bg-[var(--paper-sunk)] px-1">
      {call.model} · in {formatTokens(call.input)} · cache w {formatTokens(call.cache_write)} · cache r {formatTokens(call.cache_read)} · out {formatTokens(call.output)}
    </span>
  );
}

function FullText({ step }: { step: AgentStep }) {
  const [open, setOpen] = useState(false);
  const full = useQuery({ queryKey: ['usage-message-full', step.id, step.key], queryFn: () => api.usageMessage(step.id, true, step.key), enabled: open });
  if (!step.truncated) return null;
  if (!open) {
    return <div className="text-xs text-[var(--ink-dim)]">Showing 20,000 of {step.length.toLocaleString()} characters.{' '}
      <button type="button" className="underline" onClick={() => setOpen(true)}>Show full text</button></div>;
  }
  return <div className="mt-1 max-h-[60vh] overflow-auto">{full.isError ? 'Could not load full text.' : full.data ? <SessionContent text={full.data.text ?? ''} literal /> : 'Loading…'}</div>;
}

function Raw({ id }: { id: number }) {
  const [open, setOpen] = useState(false);
  const raw = useQuery({ queryKey: ['usage-message', id], queryFn: () => api.usageMessage(id), enabled: open });
  return <details onToggle={(e) => setOpen(e.currentTarget.open)}><summary className="cursor-pointer text-xs">Raw data</summary>
    <div className="mt-1 max-h-[60vh] overflow-auto">{raw.isError ? 'Could not load raw data.' : raw.data ? <SessionContent text={JSON.stringify(raw.data.raw, null, 2)} literal /> : 'Loading…'}</div></details>;
}

function Sub({ name }: { name: string | null }) {
  return name ? <span className="rounded border border-[var(--rule)] px-1">subagent: <SessionReferences text={name} /></span> : null;
}

function StepView({ step, show }: { step: AgentStep; show: Show }) {
  const { text: _text, ...metadata } = step;
  const label = step.step === 'response' ? 'Assistant' : step.step === 'thinking' ? 'Thinking' : step.step === 'tool_result' ? 'Tool result'
    : step.step === 'prompt' ? 'You' : step.step === 'meta' ? 'Metadata' : 'System';
  const details = <details><summary className="cursor-pointer text-xs text-[var(--ink-dim)]">Message metadata</summary>
    <SessionContent text={JSON.stringify(metadata, null, 2)} literal /><CallChip call={step.call} /><Raw id={step.id} /></details>;
  if (['thinking', 'system', 'meta'].includes(step.step)) {
    return <details className="my-2 rounded-lg border border-[var(--rule)] p-3" open={step.step === 'thinking' ? show.thinking : show.system}>
      <summary className="cursor-pointer text-sm font-medium">{label} <span className="text-xs text-[var(--ink-dim)]">{time(step.ts)}</span> <Sub name={step.subagent} /></summary>
      <div className="mt-2"><SessionContent text={step.text} literal /><FullText step={step} />{details}</div>
    </details>;
  }
  return (
    <article aria-label={step.step === 'prompt' ? 'User message' : step.step === 'response' ? 'Assistant message' : label}
      className={`my-3 rounded-xl border border-[var(--rule)] p-4 ${step.step === 'prompt' ? 'ml-auto w-[92%] bg-[var(--paper-sunk)]' : 'mr-auto w-full'} ${step.subagent ? 'ml-6 border-l border-[var(--rule)] pl-2' : ''}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-[var(--ink-dim)]">
        <span className="font-semibold text-[var(--ink)]">{label}</span><span>{time(step.ts)}</span><Sub name={step.subagent} />{details}
      </div>
      <SessionContent text={step.text} literal={step.step === 'tool_result'} /><FullText step={step} />
    </article>
  );
}

function ToolCard({ pair, show }: { pair: ToolPair; show: Show }) {
  const { call, result } = pair;
  const failed = result?.isError === true;
  const { text: _text, ...metadata } = call;
  return (
    <details className={`my-2 rounded-lg border p-3 ${failed ? 'border-red-600' : 'border-[var(--rule)]'} ${call.subagent ? 'ml-6' : ''}`}>
      <summary className="cursor-pointer space-x-2 text-xs text-[var(--ink-dim)]">
        <span className="font-semibold text-[var(--ink)]">{call.toolName ?? 'tool'}</span>
        <span>{time(call.ts)}</span>
        {pair.durationMs !== null && <span>{duration(pair.durationMs)}</span>}
        {failed && <span className="font-semibold text-red-600">✗ error</span>}
        {!result && <span>no result on this page</span>}
        <Sub name={call.subagent} />
      </summary>
      <details><summary>Tool metadata</summary><SessionContent text={JSON.stringify(metadata, null, 2)} literal /><CallChip call={call.call} /><Raw id={call.id} /></details>
      <div className="font-mono text-sm break-words"><SessionReferences text={toolSummary(call.text)} /></div>
      <details><summary className="cursor-pointer text-xs text-[var(--ink-dim)]">input ({call.length.toLocaleString()} chars)</summary>
        <SessionContent text={call.text} literal /><FullText step={call} /></details>
      {result && (
        <details open={show.results && (failed || result.length < 2000)}>
          <summary className="cursor-pointer text-xs text-[var(--ink-dim)]">result ({result.length.toLocaleString()} chars)</summary>
          <div className="max-h-[50vh] overflow-auto"><SessionContent text={result.text} literal /></div>
          <FullText step={result} /><Raw id={result.id} />
        </details>
      )}
    </details>
  );
}

function Runs({ runs }: { runs: AgentSessionRun[] }) {
  return <>{runs.map((run) => (
    <div key={run.run_id} className="mt-2 rounded border border-[var(--rule)] p-2 text-sm">
      {run.agent_name
        ? <><Link className="inline-flex items-center gap-1 underline" to={`/org/agents/${run.agent_name}`}><AgentAvatar name={run.agent_name} size={18} />{run.agent_name}</Link>{run.task_id ? <> on card <Link className="underline" to={`/board/${run.task_id}`}>{run.task_id}</Link></> : ''}</>
        : <>Task {run.task_id ? <Link className="underline" to={`/board/${encodeURIComponent(run.task_id)}`}>{run.task_id}</Link> : '?'} on {run.lane ?? '?'}</>}
      {' '}· {run.num_turns ?? '?'} turns · {run.subtype ?? ''}{run.started_at ? ` · ${zoned(run.started_at, tz)}` : ''}
      {run.verify_name && (
        <details><summary>Verify {run.verify_name}: {run.verify_passed ? 'passed' : 'failed'}{run.verify_metric != null ? ` (${run.verify_metric})` : ''}</summary>
          <SessionContent text={run.verify_output ?? ''} literal /></details>
      )}
    </div>
  ))}</>;
}

export default function UsageSession() {
  const { host = '', externalId = '' } = useParams();
  const [params] = useSearchParams();
  const source = params.get('source');
  const [show, setShowState] = useState<Show>(loadShow);
  const setShow = (patch: Partial<Show>) => { const next = { ...show, ...patch }; setShowState(next); saveShow(next); };
  const q = useInfiniteQuery({
    queryKey: ['agent-session', host, externalId, source],
    queryFn: ({ pageParam }) => api.agentSession(host, externalId, source, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  if (q.isPending) return <div className="p-4 text-[var(--ink-dim)]">Loading…</div>;
  if (q.isError) return <div className="p-4">Could not load this session: {(q.error as Error).message}</div>;
  const first = q.data.pages[0]!;
  const s = first.session;
  const steps = q.data.pages.flatMap((p) => p.steps);
  const turns = groupTurns(steps);
  const mins = s.started_at && s.ended_at ? Math.round((Date.parse(s.ended_at) - Date.parse(s.started_at)) / 60000) : null;
  return (
    <div className="h-full overflow-auto break-words p-4">
      <Link to="/usage?view=sessions" className="text-xs underline">Back to Usage</Link>
      <h1 className="mt-1 text-lg font-semibold">{s.title ?? s.first_prompt ?? s.external_id}</h1>
      <details className="my-3 rounded-lg border border-[var(--rule)] p-3"><summary className="cursor-pointer text-sm font-medium">Session metadata</summary>
      <SessionContent text={JSON.stringify(s, null, 2)} literal />
      <div className="text-xs text-[var(--ink-dim)]">
        {s.harness}{s.profile && s.profile !== 'main' ? ` (${s.profile})` : ''} on {s.host} · {s.models.join(', ') || 'model unknown'}{s.provider ? ` via ${s.provider}` : ''}
        {s.started_at ? ` · ${zoned(s.started_at, tz)}` : ''}{mins !== null ? ` · ${mins} min` : ''}
      </div>
      <div className="text-xs text-[var(--ink-dim)]">
        {s.calls} calls · in {formatTokens(s.input)} · cache w {formatTokens(s.cache_write)} · cache r {formatTokens(s.cache_read)} · out {formatTokens(s.output)}
        {s.reasoning ? ` · reasoning ${formatTokens(s.reasoning)}` : ''} · {s.tool_calls} tool calls{s.errors ? ` (${s.errors} failed)` : ''}
        {s.subagents ? ` · ${s.subagents} subagents` : ''}
        {s.harness !== 'claude-code' && s.cost_usd != null && ` · ${Number(s.cost_usd).toFixed(2)} USD`}
      </div>
      {s.harness === 'hermes' && s.parent_external_id && (
        <div className="text-xs text-[var(--ink-dim)]">Continues <Link className="underline"
          to={`/usage/session/${s.host}/${encodeURIComponent(s.parent_external_id)}?source=${encodeURIComponent(s.source)}`}>{s.parent_external_id}</Link></div>
      )}
      <Runs runs={first.runs} />
      </details>
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        <label className="flex items-center gap-1"><input type="checkbox" checked={show.thinking} onChange={(e) => setShow({ thinking: e.target.checked })} />Expand thinking</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={show.results} onChange={(e) => setShow({ results: e.target.checked })} />Expand tool results</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={show.system} onChange={(e) => setShow({ system: e.target.checked })} />Expand system metadata</label>
      </div>
      {steps.length === 0 && <p className="mt-3 text-sm text-[var(--ink-dim)]">No transcript text is stored for this session, only its token counts.</p>}
      <div className="mx-auto mt-4 max-w-5xl" aria-label="Session conversation">
        {turns.map((t, i) => (
          <div key={t.prompt?.key ?? `t${i}`} className="border-t border-[var(--rule)] py-2">
            {t.prompt && <StepView step={t.prompt} show={show} />}
            {t.items.map((it) => it.kind === 'tool'
              ? <ToolCard key={it.pair.call.key} pair={it.pair} show={show} />
              : <StepView key={it.step.key} step={it.step} show={show} />)}
          </div>
        ))}
      </div>
      {q.hasNextPage && (
        <button type="button" className="mt-2 rounded border border-[var(--rule)] px-2 py-1 text-sm" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
          {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
