import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { chipPct, untilText } from '../routes/usage/format.js';

/** Header chip: Claude plan used in the 5-hour and 7-day windows. Click for the Usage board. */
export default function UsageChip() {
  // No range: the chip only needs the latest readings, not the history.
  const now = new Date().toISOString();
  const plan = useQuery({
    queryKey: ['usage-plan-chip'], queryFn: () => api.usagePlan(now, now), refetchInterval: 60_000, retry: false,
  });
  if (plan.isError) return null;
  const five = plan.data?.current?.five_hour ?? null;
  const week = plan.data?.current?.seven_day ?? null;
  const hot = (p: typeof five) => p?.used_pct != null && !p.reset_since_reading && p.used_pct >= 80;
  const title = [
    five ? `5-hour: ${chipPct(five)} used, ${untilText(five.resets_at)}` : '5-hour: no reading',
    week ? `Weekly: ${chipPct(week)} used, ${untilText(week.resets_at)}` : 'Weekly: no reading',
    'Click for the usage breakdown',
  ].join('\n');
  return (
    <Link to="/usage" title={title} aria-label={`Claude plan usage. ${title}`}
      className="flex items-center gap-2 whitespace-nowrap rounded px-1.5 py-0.5 text-xs text-[var(--ink-dim)] hover:bg-[var(--paper-sunk)] hover:text-[var(--ink)]">
      <span>5h <b className={hot(five) ? 'text-red-600' : 'text-[var(--ink)]'}>{chipPct(five)}</b></span>
      <span>wk <b className={hot(week) ? 'text-red-600' : 'text-[var(--ink)]'}>{chipPct(week)}</b></span>
    </Link>
  );
}
