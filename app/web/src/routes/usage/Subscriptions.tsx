import { useQuery } from '@tanstack/react-query';
import { api, type QuotaWindow, type SubscriptionProvider, type SubscriptionUsage } from '../../lib/api.js';
import { untilText } from './format.js';
import { useAppTimezone } from '../../lib/useTimezone.js';

function reading(window: QuotaWindow, stale: boolean): { main: string; detail: string; current: boolean } {
  if (window.reset_since_reading) return { main: 'Reset since last reading', detail: window.last_pct === null ? 'Awaiting a new reading' : `Last reading: ${window.last_pct}% used`, current: false };
  if (window.resets_at && Date.parse(window.resets_at) <= Date.now()) return { main: 'Reading expired', detail: 'Awaiting a new reading after reset', current: false };
  if (window.used_pct === null || window.left_pct === null) return { main: 'No quota reading', detail: 'Usage is unavailable for this window', current: false };
  if (stale) return { main: `Last reading: ${window.left_pct}% remaining`, detail: `${window.used_pct}% used at observation`, current: false };
  return { main: `${window.left_pct}% remaining`, detail: `${window.used_pct}% used`, current: true };
}

function WindowCard({ window, stale, tz }: { window: QuotaWindow; stale: boolean; tz: string }) {
  const value = reading(window, stale);
  return <div className="rounded border border-[var(--rule)] bg-[var(--paper-sunk)] p-3">
    <div className="text-xs font-medium text-[var(--ink-dim)]">{window.label}</div>
    <div className="mt-1 text-xl font-semibold">{value.main}</div>
    <div className="text-xs text-[var(--ink-dim)]">{value.detail}</div>
    {value.current && <div className="mt-2 h-2 rounded bg-[var(--paper)]" role="progressbar" aria-label={`${window.label} used`} aria-valuenow={window.used_pct!} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-2 rounded bg-[var(--chart-bar)]" style={{ width: `${Math.max(0, Math.min(100, window.used_pct!))}%` }} />
    </div>}
    {window.resets_at && <div className="mt-2 text-xs text-[var(--ink-dim)]">Resets {new Date(window.resets_at).toLocaleString([], { timeZone: tz })}{Date.parse(window.resets_at) > Date.now() ? ` (${untilText(window.resets_at)})` : ''}</div>}
    {window.observed_at && <div className="text-xs text-[var(--ink-faint)]">Window observed {new Date(window.observed_at).toLocaleString([], { timeZone: tz })}</div>}
  </div>;
}

function ProviderCard({ entry, tz }: { entry: SubscriptionUsage; tz: string }) {
  return <article className="rounded border border-[var(--rule)] p-3" aria-label={`${entry.label} subscription usage`}>
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="text-sm font-semibold">{entry.label}</h2>
      {entry.status === 'unavailable' && <span className="rounded bg-[var(--paper-sunk)] px-2 py-0.5 text-xs">Unavailable</span>}
      {entry.stale && <span className="rounded bg-[var(--paper-sunk)] px-2 py-0.5 text-xs">Stale reading</span>}
    </div>
    {entry.message && <p className="mt-1 text-xs text-[var(--ink-dim)]">{entry.message}</p>}
    {entry.windows.length > 0 ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{entry.windows.map((window) => <WindowCard key={window.key} window={window} stale={entry.stale || entry.status === 'unavailable'} tz={tz} />)}</div>
      : <p className="mt-2 text-sm text-[var(--ink-dim)]">No quota windows reported.</p>}
    <div className="mt-2 text-xs text-[var(--ink-faint)]">Source: {entry.source}{entry.observed_at ? ` · observed ${new Date(entry.observed_at).toLocaleString([], { timeZone: tz })}` : ' · no reading yet'}</div>
  </article>;
}

export default function Subscriptions({ providers }: { providers: SubscriptionProvider[] }) {
  const { tz } = useAppTimezone();
  const query = useQuery({ queryKey: ['usage-subscriptions'], queryFn: api.usageSubscriptions, enabled: providers.length > 0, refetchInterval: 60_000 });
  if (providers.length === 0) return null;
  const entries = new Map(query.data?.providers.map((entry) => [entry.provider, entry]));
  return <section className="space-y-2 px-4 pt-4" aria-label="Subscription limits">
    <h2 className="text-sm font-semibold">Subscription limits</h2>
    {query.isError && <p className="text-sm text-red-600">Subscription limits did not load.</p>}
    <div className="grid gap-3 lg:grid-cols-2">{providers.map((provider) => {
      const entry = entries.get(provider);
      return entry ? <ProviderCard key={provider} entry={entry} tz={tz} /> : query.isSuccess ? <div key={provider} className="rounded border border-[var(--rule)] p-3 text-sm">{provider === 'codex' ? 'Codex' : 'Claude Code'}: no reading returned.</div> : null;
    })}</div>
  </section>;
}
