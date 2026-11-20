import type { EvidenceEvent, ReplayWindow } from '@secondbrain/contracts/observatory';
import { ordered } from '@secondbrain/contracts/observatory';
import { request } from '../../lib/http.js';
import type { ViewState } from './model.js';
import type { DiffDetail } from './ChangedDiff.js';
export interface Snapshot { window: ReplayWindow; export: string; diagnostics: Record<string, unknown> }
interface Page extends Snapshot { total: number; next: number | null }
export const CACHE_BYTES = 32 * 1024 * 1024;
/** One current window, no persistent cache. Reject incomplete snapshots instead of replaying partial history. */
export async function loadSnapshot(state: ViewState, signal: AbortSignal): Promise<Snapshot> {
  let page = await request<Page>('/observatory/window', { from: new Date(state.from).toISOString(), to: new Date(state.to).toISOString(), host: state.host, session: state.session }, { signal });
  const first = page, events = [...page.window.events];
  let bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
  const offsets = new Set<number>();
  while (page.next !== null) {
    if (bytes > CACHE_BYTES || events.length > 5000 || offsets.has(page.next)) throw new Error('Window exceeds browser budget; narrow range or select a session');
    offsets.add(page.next);
    page = await request<Page>('/observatory/window', { export: first.export, offset: page.next, limit: 500 }, { signal });
    if (page.export !== first.export || page.total !== first.total) throw new Error('Snapshot changed; restart window');
    bytes += new TextEncoder().encode(JSON.stringify(page)).byteLength;
    events.push(...page.window.events);
  }
  if (bytes > CACHE_BYTES || events.length > 5000 || ordered(events).length !== first.total) throw new Error('Incomplete or oversized window; narrow range and restart');
  return { window: { ...first.window, events: ordered(events) }, export: first.export, diagnostics: first.diagnostics };
}
export function loadDetail(id: string, token: string, signal: AbortSignal, diff = false) {
  return request<{ event: EvidenceEvent; detail: { availability: string; content: string; diff?: DiffDetail; thinking?: { availability: 'authorized-summary' | 'hidden' | 'unavailable'; summary?: string } } }>(`/observatory/events/${encodeURIComponent(id)}${diff ? '/observation' : ''}`, { export: token }, { signal });
}
