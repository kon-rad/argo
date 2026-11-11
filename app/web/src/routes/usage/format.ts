export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function untilText(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.parse(iso) - now) / 60000));
  const d = Math.floor(mins / 1440); const h = Math.floor((mins % 1440) / 60); const m = mins % 60;
  return d ? `resets in ${d} d ${h} h` : h ? `resets in ${h} h ${m} m` : `resets in ${m} m`;
}

export function money(v: number | null, currency: string): string {
  if (v === null) return '-';
  return currency === 'USD' ? `$${v.toFixed(2)}` : `${v.toFixed(2)} ${currency}`;
}

export const TYPE_SERIES = [
  { key: 'input', label: 'Input', color: 'var(--chart-bar)' },
  { key: 'cache_write', label: 'Cache write', color: 'color-mix(in oklab, var(--chart-bar) 70%, var(--paper))' },
  { key: 'cache_read', label: 'Cache read', color: 'color-mix(in oklab, var(--chart-bar) 35%, var(--paper))' },
  { key: 'output', label: 'Output', color: 'var(--ink)' },
] as const;

function tzOffsetMs(ms: number, tz: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(ms / 1000) * 1000;
}

/** End of the bucket starting at startIso: +1 h, or the next local midnight in tz (a day may be 23 or 25 h). */
export function bucketEnd(startIso: string, bucket: 'hour' | 'day', tz: string): string {
  const start = Date.parse(startIso);
  if (bucket === 'hour') return new Date(start + 3600_000).toISOString();
  const local = new Date(start + tzOffsetMs(start, tz));
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);
  let t = wall - tzOffsetMs(wall, tz);
  t = wall - tzOffsetMs(t, tz);
  return new Date(t).toISOString();
}
