export interface BarSeries { key: string; label: string; color: string; values: number[] }

const W = 900, H = 220, PAD_L = 48, PAD_B = 24;

/** Stacked bars, one column per bucket. Hand-drawn SVG like the Ring charts; click a column to select it. */
export default function StackedBars({ buckets, series, selected, onSelect, formatBucket, formatValue }: {
  buckets: string[]; series: BarSeries[]; selected: number | null; onSelect: (i: number) => void;
  formatBucket: (b: string) => string; formatValue: (n: number) => string;
}) {
  const totals = buckets.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const colW = (W - PAD_L) / Math.max(1, buckets.length);
  const y = (v: number) => (H - PAD_B) * (1 - v / max);
  const labelEvery = Math.ceil(buckets.length / 12);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Tokens per bucket">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={PAD_L} x2={W} y1={y(max * f)} y2={y(max * f)} stroke="var(--rule)" />
          <text x={PAD_L - 6} y={y(max * f) + 4} textAnchor="end" fontSize="10" fill="var(--ink-dim)">{formatValue(max * f)}</text>
        </g>
      ))}
      {buckets.map((b, i) => {
        let acc = 0;
        return (
          <g key={b} onClick={() => onSelect(i)} style={{ cursor: 'pointer' }}>
            <title>{`${formatBucket(b)}: ${formatValue(totals[i]!)} tokens`}</title>
            <rect x={PAD_L + i * colW} y={0} width={colW} height={H - PAD_B}
              fill={selected === i ? 'var(--paper-sunk)' : 'transparent'} />
            {series.map((s) => {
              const v = s.values[i] ?? 0;
              const top = y(acc + v); const h = y(acc) - top; acc += v;
              return <rect key={s.key} x={PAD_L + i * colW + colW * 0.1} y={top} width={colW * 0.8} height={Math.max(0, h)} fill={s.color} />;
            })}
            {i % labelEvery === 0 && (
              <text x={PAD_L + i * colW + colW / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--ink-dim)">{formatBucket(b)}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
