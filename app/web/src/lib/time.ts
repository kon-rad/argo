/** A timestamp in a given IANA zone with the zone shown, e.g. "Oct 11, 2026, 07:17:37 GMT+9". */
export function zoned(iso: string | null, tz: string | null, opts: { seconds?: boolean } = {}): string {
  if (!iso) return '—';
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat([], {
      timeZone: tz ?? undefined,
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: opts.seconds ? '2-digit' : undefined,
      hourCycle: 'h23', timeZoneName: 'short',
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

/** "3 min ago", "2 h ago", "4 d ago". */
export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
