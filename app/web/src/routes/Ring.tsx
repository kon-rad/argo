import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type RingDay, type RingNight } from '../lib/api.js';

/**
 * Ring data (sleep, heart rate) as a ring-ingest client pushes it to the server.
 * On the server this reads the pushed tables directly; on the Mac it reads a
 * mirror that "Pull from server" (or `secondbrain ring-pull`) refreshes.
 */

const STAGES = [
  { key: 'awake', label: 'Awake', color: 'var(--stage-awake)' },
  { key: 'rem_sleep', label: 'REM', color: 'var(--stage-rem)' },
  { key: 'light_sleep', label: 'Light', color: 'var(--stage-light)' },
  { key: 'deep_sleep', label: 'Deep', color: 'var(--stage-deep)' },
] as const;

const hm = (min: number | null): string =>
  min == null ? '—' : `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`;
const num = (v: number | null, digits = 0, unit = ''): string =>
  v == null ? '—' : `${v.toFixed(digits)}${unit}`;
const clock = (epoch: number): string =>
  new Date(epoch * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const shortDay = (day: string): string =>
  new Date(`${day}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });

export default function Ring() {
  const queryClient = useQueryClient();
  const overview = useQuery({ queryKey: ['ring'], queryFn: api.ring });
  const scored = useMemo(
    () => (overview.data?.days ?? []).filter((d) => d.sleep_score != null),
    [overview.data],
  );
  const [day, setDay] = useState<string | null>(null);
  useEffect(() => {
    if (!day && scored[0]) setDay(scored[0].day);
  }, [day, scored]);

  const night = useQuery({
    queryKey: ['ring-night', day],
    queryFn: () => api.ringNight(day!),
    enabled: day != null,
  });

  const pull = useMutation({
    mutationFn: api.ringPull,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ring'] });
      void queryClient.invalidateQueries({ queryKey: ['ring-night'] });
    },
  });

  const data = overview.data;
  return (
    <div className="mx-auto max-w-5xl overflow-y-auto px-6 py-6" style={{ height: '100%' }}>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Ring</h1>
        {data && (
          <span className="text-sm text-[var(--ink-dim)]">
            {data.total_days} days from the cyberdeck
            {data.last_received && ` · last push ${new Date(data.last_received).toLocaleString()}`}
          </span>
        )}
        {data?.can_pull && (
          <button
            type="button"
            onClick={() => pull.mutate()}
            disabled={pull.isPending}
            className="ml-auto rounded border border-[var(--rule)] px-3 py-1 text-sm hover:bg-[var(--paper-sunk)] disabled:opacity-50"
          >
            {pull.isPending ? 'Pulling…' : 'Pull from server'}
          </button>
        )}
      </div>
      {pull.isError && <p className="mt-2 text-sm text-[var(--ink)]">⚠ Pull failed: {pull.error.message}</p>}
      {pull.isSuccess && (
        <p className="mt-2 text-sm text-[var(--ink-dim)]">
          Pulled {pull.data.counts.ring_daily ?? 0} days, {pull.data.counts.ring_samples ?? 0} samples.
        </p>
      )}
      {overview.isError && <p className="mt-4 text-sm">⚠ {overview.error.message}</p>}
      {data && data.total_days === 0 && (
        <p className="mt-6 text-sm text-[var(--ink-dim)]">
          No ring data yet.{' '}
          {data.can_pull ? 'Pull from the server to copy it here.' : 'The Pi pushes every hour.'}
        </p>
      )}

      {scored.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-medium text-[var(--ink-dim)]">Sleep score, last {scored.length} nights</h2>
          <ScoreBars days={[...scored].reverse()} selected={day} onSelect={setDay} />
        </section>
      )}

      {night.data && <NightView night={night.data} />}

      {data && data.days.length > 0 && <DaysTable days={data.days} onSelect={setDay} />}
    </div>
  );
}

function ScoreBars({
  days,
  selected,
  onSelect,
}: {
  days: RingDay[];
  selected: string | null;
  onSelect: (day: string) => void;
}) {
  const [hover, setHover] = useState<RingDay | null>(null);
  const W = 720, H = 140, pad = 24;
  const step = (W - pad) / days.length;
  const barW = Math.max(4, Math.min(28, step - 2));
  const y = (score: number) => H - pad - ((H - pad - 8) * score) / 100;
  const shown = hover ?? days.find((d) => d.day === selected) ?? null;
  return (
    <div>
      <div className="h-5 text-sm text-[var(--ink)]">
        {shown && `${shortDay(shown.day)} · score ${shown.sleep_score} · ${hm(shown.total_sleep_min)} asleep`}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Sleep score per night">
        {[50, 100].map((g) => (
          <g key={g}>
            <line x1={pad} x2={W} y1={y(g)} y2={y(g)} stroke="var(--rule)" strokeWidth={1} />
            <text x={0} y={y(g) + 4} fontSize={10} fill="var(--ink-faint)">{g}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = pad + i * step + (step - barW) / 2;
          const top = y(d.sleep_score ?? 0);
          const isSel = d.day === selected;
          return (
            <g
              key={d.day}
              onMouseEnter={() => setHover(d)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect(d.day)}
              style={{ cursor: 'pointer' }}
            >
              {/* Hit target taller and wider than the bar. */}
              <rect x={pad + i * step} y={0} width={step} height={H - pad} fill="transparent" />
              <path
                d={`M${x},${H - pad} V${top + 4} q0,-4 4,-4 h${barW - 8} q4,0 4,4 V${H - pad} Z`}
                fill="var(--chart-bar)"
                opacity={isSel || hover?.day === d.day ? 1 : 0.55}
              />
              {(i === 0 || i === days.length - 1 || isSel) && (
                <text x={x + barW / 2} y={H - 8} fontSize={10} textAnchor="middle" fill="var(--ink-dim)">
                  {shortDay(d.day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function NightView({ night }: { night: RingNight }) {
  const d = night.day;
  const stats: [string, string][] = [
    ['Sleep score', num(d.sleep_score)],
    ['Asleep', hm(d.total_sleep_min)],
    ['In bed', hm(d.time_in_bed_min)],
    ['Efficiency', num(d.sleep_efficiency_pct, 0, '%')],
    ['Deep', hm(d.deep_min)],
    ['REM', hm(d.rem_min)],
    ['Sleep HRV', num(d.sleep_hrv, 0, ' ms')],
    ['Resting HR', num(d.sleep_rhr, 0, ' bpm')],
    ['Temp deviation', num(d.temp_deviation_c, 1, ' °C')],
    ['Recovery', num(d.recovery_index)],
    ['Steps', num(d.steps_total)],
    ['SpO₂', num(d.spo2_pct, 0, '%')],
  ];
  return (
    <section className="mt-6">
      <h2 className="text-base font-semibold">
        Night of {new Date(`${d.day}T00:00:00`).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
      </h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {stats.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-[var(--ink-dim)]">{k}</dt>
            <dd className="text-lg tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {night.stages.length > 0 && <Hypnogram stages={night.stages} />}
      {night.heart_rate.length > 1 && <HeartRate points={night.heart_rate} />}
    </section>
  );
}

function Hypnogram({ stages }: { stages: RingNight['stages'] }) {
  const [hover, setHover] = useState<RingNight['stages'][number] | null>(null);
  const W = 720, rowH = 22, labelW = 52;
  const t0 = stages[0]!.start;
  const t1 = stages[stages.length - 1]!.end;
  const x = (t: number) => labelW + ((W - labelW) * (t - t0)) / Math.max(1, t1 - t0);
  const H = rowH * STAGES.length + 18;
  const label = (key: string) => STAGES.find((s) => s.key === key)?.label ?? key;
  return (
    <div className="mt-6">
      <h3 className="text-sm font-medium text-[var(--ink-dim)]">Sleep stages</h3>
      <div className="h-5 text-sm">
        {hover && `${label(hover.stage)} · ${clock(hover.start)}–${clock(hover.end)} · ${Math.round((hover.end - hover.start) / 60)} min`}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Sleep stages through the night">
        {STAGES.map((s, row) => (
          <text key={s.key} x={0} y={row * rowH + rowH / 2 + 4} fontSize={11} fill="var(--ink-dim)">
            {s.label}
          </text>
        ))}
        {stages.map((st) => {
          const row = STAGES.findIndex((s) => s.key === st.stage);
          if (row < 0) return null;
          const color = STAGES[row]!.color;
          return (
            <rect
              key={st.start}
              x={x(st.start)}
              y={row * rowH + 3}
              width={Math.max(1, x(st.end) - x(st.start) - 1)}
              height={rowH - 6}
              rx={2}
              fill={color}
              onMouseEnter={() => setHover(st)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
        <text x={labelW} y={H - 2} fontSize={10} fill="var(--ink-dim)">{clock(t0)}</text>
        <text x={W} y={H - 2} fontSize={10} textAnchor="end" fill="var(--ink-dim)">{clock(t1)}</text>
      </svg>
    </div>
  );
}

function HeartRate({ points }: { points: { ts: number; value: number }[] }) {
  const [hover, setHover] = useState<{ ts: number; value: number } | null>(null);
  const W = 720, H = 120, padL = 32, padB = 16;
  const t0 = points[0]!.ts, t1 = points[points.length - 1]!.ts;
  const lo = Math.floor(Math.min(...points.map((p) => p.value)) / 5) * 5;
  const hi = Math.ceil(Math.max(...points.map((p) => p.value)) / 5) * 5;
  const x = (t: number) => padL + ((W - padL) * (t - t0)) / Math.max(1, t1 - t0);
  const y = (v: number) => H - padB - ((H - padB - 6) * (v - lo)) / Math.max(1, hi - lo);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  function onMove(e: React.MouseEvent<SVGSVGElement>): void {
    const box = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((((e.clientX - box.left) / box.width) * W - padL) / (W - padL)) * (t1 - t0);
    let best = points[0]!;
    for (const p of points) if (Math.abs(p.ts - t) < Math.abs(best.ts - t)) best = p;
    setHover(best);
  }
  return (
    <div className="mt-6">
      <h3 className="text-sm font-medium text-[var(--ink-dim)]">Heart rate in bed</h3>
      <div className="h-5 text-sm">{hover && `${clock(hover.ts)} · ${Math.round(hover.value)} bpm`}</div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Heart rate through the night"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {[lo, hi].map((v) => (
          <g key={v}>
            <line x1={padL} x2={W} y1={y(v)} y2={y(v)} stroke="var(--rule)" strokeWidth={1} />
            <text x={0} y={y(v) + 4} fontSize={10} fill="var(--ink-faint)">{v}</text>
          </g>
        ))}
        <path d={path} fill="none" stroke="var(--chart-line)" strokeWidth={2} strokeLinejoin="round" />
        {hover && (
          <>
            <line x1={x(hover.ts)} x2={x(hover.ts)} y1={0} y2={H - padB} stroke="var(--ink-faint)" strokeWidth={1} />
            <circle cx={x(hover.ts)} cy={y(hover.value)} r={4} fill="var(--chart-line)" stroke="var(--paper)" strokeWidth={2} />
          </>
        )}
        <text x={padL} y={H - 2} fontSize={10} fill="var(--ink-dim)">{clock(t0)}</text>
        <text x={W} y={H - 2} fontSize={10} textAnchor="end" fill="var(--ink-dim)">{clock(t1)}</text>
      </svg>
    </div>
  );
}

function DaysTable({ days, onSelect }: { days: RingDay[]; onSelect: (day: string) => void }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium text-[var(--ink-dim)]">Every day</h2>
      <table className="mt-2 w-full text-sm tabular-nums">
        <thead className="text-left text-xs text-[var(--ink-dim)]">
          <tr>
            {['Day', 'Score', 'Asleep', 'Deep', 'REM', 'HRV', 'Resting HR', 'Steps', 'Recovery'].map((h) => (
              <th key={h} className="py-1 pr-3 font-normal">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr
              key={d.day}
              className="cursor-pointer border-t border-[var(--rule)] hover:bg-[var(--paper-sunk)]"
              onClick={() => d.sleep_score != null && onSelect(d.day)}
            >
              <td className="py-1 pr-3">{d.day}</td>
              <td className="pr-3">{num(d.sleep_score)}</td>
              <td className="pr-3">{hm(d.total_sleep_min)}</td>
              <td className="pr-3">{hm(d.deep_min)}</td>
              <td className="pr-3">{hm(d.rem_min)}</td>
              <td className="pr-3">{num(d.sleep_hrv ?? d.hrv_avg)}</td>
              <td className="pr-3">{num(d.sleep_rhr)}</td>
              <td className="pr-3">{num(d.steps_total)}</td>
              <td className="pr-3">{num(d.recovery_index)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
