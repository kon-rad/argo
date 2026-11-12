/**
 * The app's shared time zone (docs/timezone.md): the vault's `timezone` setting from /api/meta when it has one,
 * else this browser's own zone. `useAppTimezone` keeps it current; every helper here falls back to it.
 */
let configured: string | null = null;

export function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Sets the vault's zone (null or invalid: fall back to the browser's). Returns the zone now in use. */
export function setAppTimezone(tz: string | null | undefined): string {
  configured = isTimeZone(tz) ? tz : null;
  return appTimezone();
}

export function appTimezone(): string {
  return configured ?? browserTimezone();
}

function parts(ms: number, tz: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms))) out[p.type] = p.value;
  // Some engines print midnight as 24 even with h23.
  if (out.hour === '24') out.hour = '00';
  return out;
}

/** "20261110 07:13": the Started column, 24-hour, in the given zone (default: the app's). Empty when unknown. */
export function startedStamp(iso: string | null | undefined, tz: string = appTimezone()): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const p = parts(ms, tz);
  return `${p.year}${p.month}${p.day} ${p.hour}:${p.minute}`;
}

/** "Nov 10 07:13", 24-hour, in the given zone: the date that names a skill run. */
export function shortStamp(iso: string | null | undefined, tz: string = appTimezone()): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const month = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short' }).format(new Date(ms));
  const p = parts(ms, tz);
  return `${month} ${Number(p.day)} ${p.hour}:${p.minute}`;
}

/** "HH:mm:ss" in the given zone (default: the app's). */
export function clock(iso: string | null | undefined, tz: string = appTimezone()): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  } catch {
    return '';
  }
}

/** Elapsed wall time between two instants: "45 s", "12 min", "2 h 05 min", "3 d 4 h". Null when either end is unknown. */
export function span(fromIso: string | null | undefined, toIso: string | null | undefined): string | null {
  if (!fromIso || !toIso) return null;
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** A timestamp in a given IANA zone with the zone shown, e.g. "Oct 11, 2026, 07:17:37 GMT+9". No zone: the app's. */
export function zoned(iso: string | null, tz?: string | null, opts: { seconds?: boolean } = {}): string {
  if (!iso) return '—';
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat([], {
      timeZone: tz ?? appTimezone(),
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
