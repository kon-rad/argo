import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type LocalAiAgg } from '../../lib/api.js';
import StackedBars, { type BarSeries } from '../../components/charts/StackedBars.js';
import { formatTokens } from './format.js';
import { zoned } from '../../lib/time.js';

const COLORS = ['var(--chart-bar)', 'var(--ink)', '#c2410c', '#15803d', '#7c3aed', '#0e7490', '#b45309', '#be123c'];

function speed(a: LocalAiAgg): string {
  return a.avg_output_tps == null ? '' : `${a.avg_output_tps} tok/s`;
}

/**
 * Local model use (the localai module): calls a home model host's logging gateway served, pulled every
 * 5 minutes. Tokens by caller over time, then per model and per caller, then the latest calls.
 * Renders nothing when the module is off.
 */
export default function LocalModels({ from, to, bucket, tz, fmtBucket }: {
  from: string; to: string; bucket: 'hour' | 'day'; tz: string; fmtBucket: (b: string) => string;
}) {
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const on = (meta.data?.modules ?? []).includes('localai');
  const [caller, setCaller] = useState<string | undefined>();
  const summary = useQuery({ queryKey: ['local-ai-summary', from, to, bucket], queryFn: () => api.localAiSummary(from, to, bucket, tz), enabled: on, refetchInterval: 60_000 });
  const runs = useQuery({ queryKey: ['local-ai-runs', from, to, caller], queryFn: () => api.localAiRuns(from, to, caller), enabled: on, refetchInterval: 60_000 });

  const { buckets, series } = useMemo(() => {
    const rows = summary.data?.series ?? [];
    const buckets = [...new Set(rows.map((r) => r.bucket))].sort();
    const keys = [...new Set(rows.map((r) => r.key))].sort();
    const series: BarSeries[] = keys.map((key, i) => ({
      key, label: key, color: COLORS[i % COLORS.length]!,
      values: buckets.map((b) => rows.filter((r) => r.bucket === b && r.key === key).reduce((n, r) => n + Number(r.prompt) + Number(r.output), 0)),
    }));
    return { buckets, series };
  }, [summary.data]);

  if (!on) return null;
  const d = summary.data;
  const t = d?.total;
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">Local models</h2>
      <p className="text-xs text-[var(--ink-dim)]">
        Calls the home model host served (no cloud, no money: electricity only).
        {t ? ` ${t.runs} calls, ${formatTokens(Number(t.prompt))} in, ${formatTokens(Number(t.output))} out, ${t.energy_wh} Wh${t.errors ? `, ${t.errors} errors` : ''}.` : ''}
        {(d?.hosts ?? []).map((h) => (
          <span key={h.host}> {h.display}: pulled {h.last_ok_at ? zoned(h.last_ok_at, tz) : 'never'}{h.error ? <span className="text-[#be123c]"> (last try failed: {h.error})</span> : null}.</span>
        ))}
      </p>
      {buckets.length > 0 && (
        <>
          <StackedBars buckets={buckets} series={series} selected={null} onSelect={() => {}} formatBucket={fmtBucket} formatValue={formatTokens} />
          <div className="flex flex-wrap gap-3 text-xs text-[var(--ink-dim)]">
            {series.map((s) => <span key={s.key}><span className="inline-block h-2 w-2" style={{ background: s.color }} /> {s.label}</span>)}
          </div>
        </>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="text-left text-xs text-[var(--ink-dim)]"><tr>
            <th>Model</th><th className="text-right">Calls</th><th className="text-right">In</th><th className="text-right">Out</th><th className="text-right">Speed</th><th className="text-right">Wh</th>
          </tr></thead>
          <tbody>
            {(d?.models ?? []).map((m) => (
              <tr key={`${m.host}|${m.model}`} className="border-t border-[var(--rule)]">
                <td>{m.model} <span className="text-xs text-[var(--ink-dim)]">{m.service}</span></td>
                <td className="text-right">{m.runs}{m.errors ? <span className="text-xs text-[#be123c]"> ({m.errors} err)</span> : null}</td>
                <td className="text-right">{formatTokens(Number(m.prompt))}</td><td className="text-right">{formatTokens(Number(m.output))}</td>
                <td className="text-right">{speed(m)}</td><td className="text-right">{m.energy_wh}</td>
              </tr>
            ))}
            {d?.models?.length === 0 && <tr><td colSpan={6} className="py-2 text-xs text-[var(--ink-faint)]">No local calls in this range.</td></tr>}
          </tbody>
        </table></div>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="text-left text-xs text-[var(--ink-dim)]"><tr>
            <th>Caller</th><th className="text-right">Calls</th><th className="text-right">In</th><th className="text-right">Out</th><th className="text-right">Speed</th>
          </tr></thead>
          <tbody>
            {(d?.callers ?? []).map((c) => (
              <tr key={c.caller} className="border-t border-[var(--rule)]">
                <td><button type="button" className="hover:underline" onClick={() => setCaller(caller === c.caller ? undefined : c.caller)}>{c.caller}</button>{caller === c.caller ? ' (shown below)' : ''}</td>
                <td className="text-right">{c.runs}</td><td className="text-right">{formatTokens(Number(c.prompt))}</td>
                <td className="text-right">{formatTokens(Number(c.output))}</td><td className="text-right">{speed(c)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead className="text-left text-xs text-[var(--ink-dim)]"><tr>
          <th>When</th><th>Caller</th><th>Model</th><th>State</th><th className="text-right">In</th><th className="text-right">Out</th>
          <th className="text-right">First token</th><th className="text-right">tok/s</th><th className="text-right">Sec</th>
        </tr></thead>
        <tbody>
          {(runs.data?.runs ?? []).map((r) => (
            <tr key={`${r.host}|${r.id}`} className="border-t border-[var(--rule)]" title={r.error ?? ''}>
              <td>{zoned(r.started_at, tz)}</td><td>{r.caller}</td><td>{r.model}{r.cold_start ? <span className="text-xs text-[var(--ink-dim)]"> cold</span> : null}</td>
              <td className={r.state === 'error' ? 'text-[#be123c]' : ''}>{r.state}</td>
              <td className="text-right">{r.prompt_tokens == null ? '' : formatTokens(r.prompt_tokens)}</td>
              <td className="text-right">{r.output_tokens == null ? (r.audio_seconds ? `${r.audio_seconds.toFixed(1)} s audio` : '') : formatTokens(r.output_tokens)}</td>
              <td className="text-right">{r.ttft_ms == null ? '' : `${(r.ttft_ms / 1000).toFixed(1)} s`}</td>
              <td className="text-right">{r.output_tps == null ? '' : r.output_tps.toFixed(1)}</td>
              <td className="text-right">{r.total_ms == null ? '' : (r.total_ms / 1000).toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </section>
  );
}
