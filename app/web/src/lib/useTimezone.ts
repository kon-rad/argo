import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';
import { setAppTimezone } from './time.js';

/**
 * The zone every time on the page is shown in, and the Usage charts are bucketed by: the vault's `timezone`
 * (secondbrain.json, changed with `secondbrain timezone set <Area/City>`), else this browser's zone. The
 * server's own zone is never used: it says where the machine is, not where its owner is.
 */
export function useAppTimezone(): { tz: string; source: 'setting' | 'browser' } {
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: 60_000 });
  const configured = meta.data?.timezone ?? null;
  const tz = setAppTimezone(configured);
  return { tz, source: configured !== null && tz === configured ? 'setting' : 'browser' };
}
