const W = 900, H = 160, PAD_L = 40, PAD_B = 18;

/** Lines over time (x = epoch ms), y from 0 to yMax. */
export default function LineChart({ lines, yMax, label, xMin, xMax }: {
  lines: { key: string; color: string; points: { x: number; y: number }[] }[]; yMax: number; label: string; xMin: number; xMax: number;
}) {
  const sx = (x: number) => PAD_L + ((x - xMin) / Math.max(1, xMax - xMin)) * (W - PAD_L);
  const sy = (v: number) => (H - PAD_B) * (1 - v / yMax);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={label}>
      {[0, 50, 100].map((v) => (
        <g key={v}>
          <line x1={PAD_L} x2={W} y1={sy(v)} y2={sy(v)} stroke="var(--rule)" />
          <text x={PAD_L - 6} y={sy(v) + 4} textAnchor="end" fontSize="10" fill="var(--ink-dim)">{v}%</text>
        </g>
      ))}
      {lines.map((l) => l.points.length > 0 && (
        <path key={l.key} fill="none" stroke={l.color} strokeWidth={2} strokeLinejoin="round"
          d={l.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ')} />
      ))}
    </svg>
  );
}
