import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, type AgentSessionRun, type AgentStep } from '../../lib/api.js';
import { zoned } from '../../lib/time.js';
import { formatTokens } from './format.js';
import { duration, groupTurns, toolSummary, type ToolPair } from './steps.js';

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const SHOW_KEY = 'usage-session-show';
type Show = { thinking: boolean; results: boolean; system: boolean };
const DEFAULT_SHOW: Show = { thinking: false, results: true, system: false };

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
  return <pre className="mt-1 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-xs">{full.data ? full.data.text ?? '' : 'Loading…'}</pre>;
}

function Raw({ id }: { id: number }) {
  const [open, setOpen] = useState(false);
  const raw = useQuery({ queryKey: ['usage-message', id], queryFn: () => api.usageMessage(id), enabled: open });
  if (!open) return <button type="button" className="text-xs text-[var(--ink-faint)] underline" onClick={() => setOpen(true)}>raw</button>;
  return <pre className="mt-1 max-h-[60vh] overflow-auto whitespace-pre-wrap text-xs">{raw.data ? JSON.stringify(raw.data.raw, null, 2) : 'Loading…'}</pre>;
}

function Sub({ name }: { name: string | null }) {
  return name ? <span className="rounded border border-[var(--rule)] px-1">subagent: {name}</span> : null;
}

function StepView({ step, show }: { step: AgentStep; show: Show }) {
  if (step.step === 'thinking' && !show.thinking) return null;
  if ((step.step === 'system' || step.step === 'meta') && !show.system) return null;
  const label = step.step === 'response' ? 'Response' : step.step === 'thinking' ? 'Thinking' : step.step === 'tool_result' ? 'Tool result'
    : step.step === 'prompt' ? 'Prompt' : step.step;
  return (
    <div className={`py-1 ${step.subagent ? 'ml-6 border-l border-[var(--rule)] pl-2' : ''}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ink-dim)]">
        <span className="font-semibold text-[var(--ink)]">{label}</span><span>{time(step.ts)}</span><Sub name={step.subagent} /><CallChip call={step.call} /><Raw id={step.id} />
      </div>
      <pre className={`whitespace-pre-wrap break-words text-sm ${step.step === 'thinking' ? 'italic text-[var(--ink-dim)]' : ''}`}>{step.text}</pre>
      <FullText step={step} />
    </div>
  );
}

function ToolCard({ pair, show }: { pair: ToolPair; show: Show }) {
  const { call, result } = pair;
  const failed = result?.isError === true;
  return (
    <div className={`my-1 rounded border p-2 ${failed ? 'border-red-600' : 'border-[var(--rule)]'} ${call.subagent ? 'ml-6' : ''}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ink-dim)]">
        <span className="font-semibold text-[var(--ink)]">{call.toolName ?? 'tool'}</span>
        <span>{time(call.ts)}</span>
        {pair.durationMs !== null && <span>{duration(pair.durationMs)}</span>}
        {failed && <span className="font-semibold text-red-600">✗ error</span>}
        {!result && <span>no result on this page</span>}
        <Sub name={call.subagent} /><CallChip call={call.call} /><Raw id={call.id} />
      </div>
      <div className="font-mono text-sm break-words">{toolSummary(call.text)}</div>
      <details><summary className="cursor-pointer text-xs text-[var(--ink-dim)]">input ({call.length.toLocaleString()} chars)</summary>
        <pre className="whitespace-pre-wrap break-words text-xs">{call.text}</pre></details>
      {result && (
        <details open={show.results && (failed || result.length < 2000)}>
          <summary className="cursor-pointer text-xs text-[var(--ink-dim)]">result ({result.length.toLocaleString()} chars)</summary>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words text-xs">{result.text}</pre>
          <FullText step={result} />
        </details>
      )}
    </div>
  );
}

function Runs({ runs }: { runs: AgentSessionRun[] }) {
  return <>{runs.map((run) => (
    <div key={run.run_id} className="mt-2 rounded border border-[var(--rule)] p-2 text-sm">
      {run.agent_name
        ? <><Link className="underline" to={`/org/agents/${run.agent_name}`}>{run.agent_name}</Link>{run.task_id ? <> on card <Link className="underline" to={`/board/${run.task_id}`}>{run.task_id}</Link></> : ''}</>
        : <>Task {run.task_id ?? '?'} on {run.lane ?? '?'}</>}
      {' '}· {run.num_turns ?? '?'} turns · {run.subtype ?? ''}{run.started_at ? ` · ${zoned(run.started_at, tz)}` : ''}
      {run.verify_name && (
        <details><summary>Verify {run.verify_name}: {run.verify_passed ? 'passed' : 'failed'}{run.verify_metric != null ? ` (${run.verify_metric})` : ''}</summary>
          <pre className="whitespace-pre-wrap text-xs">{run.verify_output}</pre></details>
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
      <Link to="/usage" className="text-xs underline">Back to Usage</Link>
      <h1 className="mt-1 text-lg font-semibold">{s.title ?? s.first_prompt ?? s.external_id}</h1>
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
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        <label className="flex items-center gap-1"><input type="checkbox" checked={show.thinking} onChange={(e) => setShow({ thinking: e.target.checked })} />thinking</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={show.results} onChange={(e) => setShow({ results: e.target.checked })} />open tool results</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={show.system} onChange={(e) => setShow({ system: e.target.checked })} />system</label>
      </div>
      {steps.length === 0 && <p className="mt-3 text-sm text-[var(--ink-dim)]">No transcript text is stored for this session, only its token counts.</p>}
      <div className="mt-2">
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
