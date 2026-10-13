import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type CronJob } from '../lib/api.js';
import { ago, zoned } from '../lib/time.js';

/**
 * Hermes cron jobs from every profile (active, paused, finished, removed),
 * each with its full run history and every output it produced, plus the
 * droplet's systemd timers. Data comes from `secondbrain agents-sync`.
 */

function stateLabel(j: CronJob): string {
  if (j.removed_at) return 'removed';
  if (j.state === 'scheduled' && j.enabled) return 'active';
  return j.state ?? (j.enabled ? 'active' : 'paused');
}

export default function Cron() {
  const { profile, jobId } = useParams();
  const navigate = useNavigate();
  const jobs = useQuery({ queryKey: ['cron-jobs'], queryFn: api.cronJobs });
  const timers = useQuery({ queryKey: ['cron-timers'], queryFn: api.cronTimers });

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-96 shrink-0 overflow-y-auto border-r border-[var(--rule)]">
        <div className="border-b border-[var(--rule)] px-3 py-2">
          <h1 className="font-semibold tracking-tight">Cron jobs</h1>
          <div className="text-xs text-[var(--ink-faint)]">
            {jobs.data?.last_sync ? `synced ${ago(jobs.data.last_sync.ran_at)}` : 'not synced yet'}
          </div>
        </div>
        {jobs.isError && <p className="p-3 text-sm">⚠ {jobs.error.message}</p>}
        <table className="w-full text-sm">
          <tbody>
            {jobs.data?.jobs.map((j) => {
              const label = stateLabel(j);
              const sel = j.profile === profile && j.job_id === jobId;
              return (
                <tr
                  key={`${j.profile}/${j.job_id}`}
                  onClick={() => navigate(`/cron/${encodeURIComponent(j.profile)}/${encodeURIComponent(j.job_id)}`)}
                  className={`cursor-pointer border-b border-[var(--rule)] hover:bg-[var(--paper-sunk)] ${sel ? 'bg-[var(--paper-sunk)]' : ''}`}
                >
                  <td className="px-3 py-2">
                    <div className="font-medium">{j.name}</div>
                    <div className="text-xs text-[var(--ink-dim)]">
                      {j.profile} · <code>{j.schedule ?? '—'}</code> · {j.runs ?? 0} runs · {j.outputs ?? 0} outputs
                    </div>
                    <div className="text-xs text-[var(--ink-faint)]">
                      {label === 'active' ? `next ${zoned(j.next_run_at, j.timezone)}` : `last ${zoned(j.last_run_at, j.timezone)}`}
                    </div>
                  </td>
                  <td className="pr-3 text-right align-top text-xs">
                    {/* State is spelled out, never color alone. */}
                    <span className={`inline-block rounded border px-1.5 py-0.5 ${label === 'active' ? 'border-[var(--accent)] text-[var(--ink)]' : 'border-[var(--rule)] text-[var(--ink-dim)]'}`}>
                      {label === 'active' ? '● active' : label === 'paused' ? '❚❚ paused' : label}
                    </span>
                    {j.last_status && j.last_status !== 'ok' && <div className="mt-1">⚠ {j.last_status}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="border-t border-[var(--rule)] px-3 py-2">
          <h2 className="text-sm font-medium">systemd timers on this server</h2>
          {timers.data && !timers.data.available && (
            <p className="text-xs text-[var(--ink-dim)]">Not available here (the Mac has no systemd).</p>
          )}
          <ul className="mt-1 space-y-1 text-xs">
            {timers.data?.timers.map((t) => (
              <li key={t.unit}>
                <code>{t.unit.replace(/\.timer$/, '')}</code>
                <span className="text-[var(--ink-faint)]"> · last {ago(t.last)} · next {t.next ? new Date(t.next).toLocaleString() : '—'}</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto">
        {profile && jobId ? <JobView profile={profile} jobId={jobId} /> : (
          <p className="p-6 text-sm text-[var(--ink-dim)]">Pick a job to see every run and what it produced.</p>
        )}
      </section>
    </div>
  );
}

function JobView({ profile, jobId }: { profile: string; jobId: string }) {
  const detail = useQuery({ queryKey: ['cron-job', profile, jobId], queryFn: () => api.cronJob(profile, jobId) });
  const [open, setOpen] = useState<string | null>(null);
  if (detail.isPending) return <p className="p-6 text-sm text-[var(--ink-dim)]">Loading…</p>;
  if (detail.isError) return <p className="p-6 text-sm">⚠ {detail.error.message}</p>;
  const { job: j, runs, outputs, sessions } = detail.data;
  const tz = j.timezone;
  const sessionFor = (iso: string | null) => {
    // Hermes names a run's session cron_<job>_<local YYYYMMDD_HHMMSS>; match the nearest one.
    if (!iso) return null;
    const t = new Date(iso).getTime();
    let best: (typeof sessions)[number] | null = null;
    for (const s of sessions) {
      if (!s.started_at) continue;
      const d = Math.abs(new Date(s.started_at).getTime() - t);
      if (d < 15 * 60_000 && (!best || d < Math.abs(new Date(best.started_at!).getTime() - t))) best = s;
    }
    return best;
  };

  return (
    <div className="mx-auto max-w-3xl px-6 py-5">
      <h1 className="text-lg font-semibold tracking-tight">{j.name}</h1>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        {([
          ['State', stateLabel(j)],
          ['Schedule', j.schedule ?? '—'],
          ['Timezone', tz ?? 'UTC'],
          ['Next run', zoned(j.next_run_at, tz)],
          ['Last run', zoned(j.last_run_at, tz)],
          ['Last status', j.last_status ?? '—'],
          ['Bot', j.profile],
          ['Skill', j.skill ?? '—'],
          ['Delivers to', j.deliver ?? '—'],
        ] as const).map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-[var(--ink-dim)]">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {j.last_error && <p className="mt-2 text-sm">⚠ {j.last_error}</p>}
      {j.prompt && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-[var(--ink-dim)]">Prompt{j.script ? ` (pre-run script ${j.script})` : ''}</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-[var(--paper-sunk)] p-2 text-xs">{j.prompt}</pre>
        </details>
      )}

      <h2 className="mt-6 text-sm font-medium">Outputs ({outputs.length})</h2>
      <ol className="mt-2 space-y-2">
        {outputs.map((o) => (
          <li key={o.file_name} className="rounded border border-[var(--rule)]">
            <button
              type="button"
              onClick={() => setOpen(open === o.file_name ? null : o.file_name)}
              className="flex w-full items-baseline gap-3 px-3 py-2 text-left text-sm hover:bg-[var(--paper-sunk)]"
            >
              <span className="font-medium tabular-nums">{zoned(o.run_at, tz)}</span>
              <span className="truncate text-xs text-[var(--ink-dim)]">{o.preview.replace(/\s+/g, ' ').slice(0, 120)}</span>
              <span className="ml-auto shrink-0 text-xs text-[var(--ink-faint)]">{open === o.file_name ? '▾' : '▸'}</span>
            </button>
            {open === o.file_name && <Output profile={j.profile} jobId={j.job_id} file={o.file_name} />}
          </li>
        ))}
      </ol>

      <h2 className="mt-6 text-sm font-medium">Runs ({runs.length})</h2>
      <table className="mt-2 w-full text-sm tabular-nums">
        <thead className="text-left text-xs text-[var(--ink-dim)]">
          <tr>
            <th className="py-1 pr-3 font-normal">Started</th>
            <th className="pr-3 font-normal">Took</th>
            <th className="pr-3 font-normal">Status</th>
            <th className="pr-3 font-normal">Transcript</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const took = r.started_at && r.finished_at
              ? `${Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000)} s`
              : '—';
            const s = sessionFor(r.started_at ?? r.claimed_at);
            return (
              <tr key={r.id} className="border-t border-[var(--rule)]">
                <td className="py-1 pr-3">{zoned(r.started_at ?? r.claimed_at, tz)}</td>
                <td className="pr-3">{took}</td>
                <td className="pr-3">{r.status === 'completed' ? '✓ completed' : r.status === 'failed' ? `⚠ failed${r.error ? `: ${r.error}` : ''}` : r.status}</td>
                <td className="pr-3">
                  {s ? <Link className="text-[var(--accent)] underline" to={`/agents/history/${s.id}`}>{s.message_count} msgs</Link> : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {runs.length === 0 && <p className="text-sm text-[var(--ink-dim)]">No recorded runs (Hermes started logging executions on 2026-09-30).</p>}
    </div>
  );
}

function Output({ profile, jobId, file }: { profile: string; jobId: string; file: string }) {
  const out = useQuery({ queryKey: ['cron-output', profile, jobId, file], queryFn: () => api.cronOutput(profile, jobId, file) });
  if (out.isPending) return <p className="px-3 pb-2 text-sm text-[var(--ink-dim)]">Loading…</p>;
  if (out.isError) return <p className="px-3 pb-2 text-sm">⚠ {out.error.message}</p>;
  // Hermes writes a header and the full prompt, then `## Response`: lead with the response.
  const at = out.data.content.indexOf('\n## Response');
  const response = at >= 0 ? out.data.content.slice(at + 12).trim() : out.data.content;
  const prompt = at >= 0 ? out.data.content.slice(0, at) : null;
  return (
    <div className="border-t border-[var(--rule)] px-3 py-2 text-sm">
      <div className="prose max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{response}</ReactMarkdown>
      </div>
      {prompt && (
        <details className="mt-2 text-xs text-[var(--ink-dim)]">
          <summary className="cursor-pointer">Header and prompt sent to the agent</summary>
          <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-words">{prompt}</pre>
        </details>
      )}
    </div>
  );
}
