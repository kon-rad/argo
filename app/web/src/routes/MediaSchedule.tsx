import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type MediaBrandResult, type MediaCalendar, type MediaChannel, type MediaPost } from '../lib/api.js';
import { zoned } from '../lib/time.js';

/**
 * A content calendar per brand. The brand's channels, style guides and tracker
 * projects come from its media-brand.md in the vault; posts come from the
 * social module. Everything you can filter by lives in the URL:
 * /media-schedule?brand=argo&view=month&date=2026-10-21
 */

const VIEWS = ['month', 'week', 'list'] as const;
type View = (typeof VIEWS)[number];
const DAY = 86_400_000;

const chip = 'inline-block rounded border px-1.5 py-0.5 text-xs';
/** One colour per channel position; the channel name is always in the text too. */
const COLORS = ['#2f6f9f', '#a05a2c', '#4b8a4b', '#8a4b8a', '#9a7b1c', '#2f8a8a', '#a0414a', '#5b5ba0'];

const localDay = (d: Date): string => d.toLocaleDateString('en-CA');
const parseDay = (s: string | null): Date => {
  const m = s && /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
};
const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d: Date): Date => addDays(d, -((d.getDay() + 6) % 7));

/** The visible range in the browser's zone: a 6-week grid for the month, 7 days for the week, the month for the list. */
export function rangeFor(view: View, anchor: Date): { from: Date; to: Date; title: string } {
  if (view === 'week') {
    const from = mondayOf(anchor);
    return { from, to: addDays(from, 7), title: `Week of ${localDay(from)}` };
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const title = first.toLocaleDateString([], { month: 'long', year: 'numeric' });
  if (view === 'list') return { from: first, to: new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1), title };
  const from = mondayOf(first);
  return { from, to: addDays(from, 42), title };
}

/** Posts from one draft file at one time are one entry with a chip per network (one reel goes to several). */
export interface Entry { key: string; posts: MediaPost[]; at: string }
export function groupPosts(posts: MediaPost[]): Entry[] {
  const groups = new Map<string, Entry>();
  for (const p of posts) {
    const key = p.source_path ? `${p.source_path}|${p.scheduled_for}` : `post:${p.id}`;
    const g = groups.get(key) ?? { key, posts: [], at: p.scheduled_for };
    g.posts.push(p);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.at.localeCompare(b.at));
}

const STATUS_LABEL: Record<MediaPost['status'], string> = {
  draft: 'draft', queued: 'queued', publishing: 'publishing', posted: 'posted', failed: 'failed', canceled: 'canceled',
};
/** A shape per status as well as colour: hollow = not out yet, filled = posted, red = failed. */
function Marker({ status }: { status: MediaPost['status'] }) {
  const filled = status === 'posted';
  const color = status === 'failed' ? 'var(--warn)' : 'currentColor';
  return (
    <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full border" style={{ borderColor: color, background: filled ? color : status === 'queued' || status === 'publishing' ? `color-mix(in srgb, ${color} 40%, transparent)` : 'transparent' }} />
  );
}

export default function MediaSchedule() {
  const [sp, setSp] = useSearchParams();
  const brands = useQuery({ queryKey: ['media-brands'], queryFn: api.mediaBrands, staleTime: 30_000 });
  const list = brands.data?.brands ?? [];
  const slug = sp.get('brand') ?? list[0]?.slug ?? '';
  // A phone gets the list; the month grid needs width.
  const phone = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches;
  const view: View = (VIEWS as readonly string[]).includes(sp.get('view') ?? '') ? (sp.get('view') as View) : phone ? 'list' : 'month';
  const anchor = parseDay(sp.get('date'));
  const showCanceled = sp.get('canceled') === '1';
  const range = rangeFor(view, anchor);
  const set = (patch: Record<string, string | null>): void => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) (v === null ? next.delete(k) : next.set(k, v));
    setSp(next, { replace: true });
  };

  const brand = list.find((b) => b.slug === slug);
  const calendar = useQuery({
    queryKey: ['media-calendar', slug, range.from.toISOString(), range.to.toISOString()],
    queryFn: () => api.mediaCalendar(slug, range.from.toISOString(), range.to.toISOString()),
    enabled: Boolean(brand?.ok),
    retry: false,
  });

  if (brands.isPending) return <div className="p-6 text-[var(--ink-dim)]">Loading…</div>;
  if (brands.isError) return <div className="p-6 text-[var(--warn)]">{brands.error.message}</div>;
  if (!list.length) {
    return (
      <div className="p-6 text-[var(--ink-dim)]">
        No brands are set up. Add <code>media.brands</code> to <code>secondbrain.json</code>, each pointing at a <code>media-brand.md</code>.
      </div>
    );
  }

  const step = (dir: number): void => {
    const d = view === 'week' ? addDays(anchor, 7 * dir) : new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
    set({ date: localDay(d) });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--rule)] px-3 py-2">
        <h1 className="font-semibold tracking-tight">Media schedule</h1>
        <label className="text-sm">
          <span className="sr-only">Brand</span>
          <select aria-label="Brand" className="rounded border border-[var(--rule)] bg-transparent px-1 py-0.5" value={slug} onChange={(e) => set({ brand: e.target.value, post: null })}>
            {list.map((b) => <option key={b.slug} value={b.slug}>{b.ok ? b.name : `${b.slug} (error)`}</option>)}
          </select>
        </label>
        <div className="flex items-center gap-1" role="group" aria-label="View">
          {VIEWS.map((v) => (
            <button key={v} type="button" onClick={() => set({ view: v })} aria-pressed={view === v} className={`rounded px-2 py-0.5 text-sm ${view === v ? 'bg-[var(--paper-sunk)] text-[var(--ink)]' : 'text-[var(--ink-dim)]'}`}>
              {v}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-sm">
          <button type="button" aria-label="Previous" className="rounded border border-[var(--rule)] px-2" onClick={() => step(-1)}>‹</button>
          <span className="min-w-36 text-center">{range.title}</span>
          <button type="button" aria-label="Next" className="rounded border border-[var(--rule)] px-2" onClick={() => step(1)}>›</button>
          <button type="button" className="ml-1 rounded border border-[var(--rule)] px-2" onClick={() => set({ date: null })}>Today</button>
        </div>
        <label className="flex items-center gap-1 text-xs text-[var(--ink-dim)]">
          <input type="checkbox" checked={showCanceled} onChange={(e) => set({ canceled: e.target.checked ? '1' : null })} /> show canceled
        </label>
      </div>

      {!brand ? (
        <div className="p-6 text-[var(--ink-dim)]">No brand called <code>{slug}</code>.</div>
      ) : !brand.ok ? (
        <ErrorCard brand={brand} />
      ) : (
        <Body brand={brand} calendar={calendar.data} loading={calendar.isPending} error={calendar.isError ? calendar.error.message : null} view={view} anchor={anchor} range={range} showCanceled={showCanceled} selected={sp.get('post')} onSelect={(id) => set({ post: id })} />
      )}
    </div>
  );
}

function ErrorCard({ brand }: { brand: Extract<MediaBrandResult, { ok: false }> }) {
  return (
    <div className="m-4 rounded border border-[var(--warn)] p-3 text-sm" role="alert">
      <div className="font-semibold">This brand's config could not be loaded.</div>
      <div className="mt-1">
        <Link className="underline" to={`/file/${brand.error.file}`}>{brand.error.file}</Link>
        {brand.error.line ? `, line ${brand.error.line}` : ''}: {brand.error.message}
      </div>
      <div className="mt-1 text-xs text-[var(--ink-dim)]">Other brands still work; pick one above.</div>
    </div>
  );
}

function Body(props: {
  brand: Extract<MediaBrandResult, { ok: true }>;
  calendar: MediaCalendar | undefined;
  loading: boolean;
  error: string | null;
  view: View;
  anchor: Date;
  range: { from: Date; to: Date };
  showCanceled: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { brand, calendar, view, range, showCanceled, selected } = props;
  const channels = calendar?.channels ?? brand.channels;
  const color = (id: string): string => COLORS[Math.max(0, brand.channels.findIndex((c) => c.id === id)) % COLORS.length]!;
  const posts = useMemo(() => (calendar?.posts ?? []).filter((p) => showCanceled || p.status !== 'canceled'), [calendar, showCanceled]);
  const entries = useMemo(() => groupPosts(posts), [posts]);
  const open = posts.find((p) => String(p.id) === selected) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto md:flex-row md:overflow-hidden">
      <div className="min-w-0 flex-1 overflow-auto p-3">
        {brand.warnings.length > 0 && (
          <ul className="mb-3 rounded border border-[var(--rule)] p-2 text-xs text-[var(--ink-dim)]">
            {brand.warnings.map((w) => <li key={w}>Warning: {w}</li>)}
          </ul>
        )}
        <ChannelsPanel brand={brand} channels={channels} color={color} />
        <LinksStrip brand={brand} />
        {props.error && <div className="my-2 text-sm text-[var(--warn)]">{props.error}</div>}
        {props.loading && !props.error && <div className="my-2 text-sm text-[var(--ink-dim)]">Loading posts…</div>}
        {view === 'list' ? (
          <ListView entries={entries} color={color} onSelect={props.onSelect} />
        ) : (
          <Grid view={view} anchor={props.anchor} from={range.from} entries={entries} color={color} onSelect={props.onSelect} />
        )}
        {!props.loading && !entries.length && <p className="mt-2 text-sm text-[var(--ink-faint)]">No posts in this range.</p>}
      </div>
      {open && <Detail post={open} channel={brand.channels.find((c) => c.id === open.channelId)} onClose={() => props.onSelect(null)} />}
    </div>
  );
}

function ChannelsPanel({ brand, channels, color }: { brand: Extract<MediaBrandResult, { ok: true }>; channels: MediaChannel[]; color: (id: string) => string }) {
  return (
    <section className="mb-3 rounded border border-[var(--rule)] p-2" aria-label="Channels">
      <h2 className="mb-1 text-sm font-semibold">Channels</h2>
      <ul className="space-y-1 text-sm">
        {channels.map((c) => {
          const a = c.account;
          const health = a ? (a.state === 'connected' ? (a.tokenExpiresInDays === null ? 'connected' : `connected, token expires in ${a.tokenExpiresInDays} d`) : a.state) : null;
          return (
            <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: color(c.id) }} />
              <span className="font-medium">{c.network}</span>
              {c.url ? <a className="text-[var(--accent)] underline" href={c.url} target="_blank" rel="noreferrer">{c.handle ?? c.url}</a> : <span>{c.handle ?? c.id}{c.urlUnconfirmed ? ' (profile not confirmed)' : ''}</span>}
              <span className={`${chip} border-[var(--rule)] text-[var(--ink-dim)]`}>{c.posting === 'manual' ? 'manual' : `api: ${c.posting}`}</span>
              {health && <span className={`text-xs ${a?.state === 'connected' ? 'text-[var(--ink-dim)]' : 'text-[var(--warn)]'}`}>{health}</span>}
              {c.style_guide && (c.styleGuideMissing ? <span className="text-xs text-[var(--warn)]">style guide missing: {c.style_guide}</span> : <Link className="text-xs underline" to={`/file/${c.style_guide}`}>style guide</Link>)}
              {c.files && <Link className="text-xs underline" to={`/file/${c.files}`}>files</Link>}
              {c.posting !== 'manual' && <span className="text-xs text-[var(--ink-dim)]">{c.counts.queued} queued, {c.counts.posted} posted{c.counts.draft ? `, ${c.counts.draft} draft` : ''}{c.counts.failed ? `, ${c.counts.failed} failed` : ''}</span>}
              {c.note && <span className="text-xs text-[var(--ink-faint)]">{c.note}</span>}
            </li>
          );
        })}
      </ul>
      {brand.styleGuides.length > 0 && (
        <p className="mt-1 text-xs text-[var(--ink-dim)]">
          Brand-wide style guides:{' '}
          {brand.styleGuides.map((g, i) => (
            <span key={g.path}>{i > 0 && ', '}{g.missing ? <span className="text-[var(--warn)]">{g.path} (missing)</span> : <Link className="underline" to={`/file/${g.path}`}>{g.path.split('/').pop()}</Link>}</span>
          ))}
        </p>
      )}
    </section>
  );
}

/** The brand's tracker projects and the open cards behind them (cards need the org module and the hub; both optional). */
function LinksStrip({ brand }: { brand: Extract<MediaBrandResult, { ok: true }> }) {
  const links = useQuery({ queryKey: ['org', 'tasks'], queryFn: () => api.orgTasks(), staleTime: 30_000, retry: false });
  const board = useQuery({ queryKey: ['hub-board', 'exo'], queryFn: () => api.board('exo'), staleTime: 30_000, retry: false });
  const status = new Map((board.data?.tasks ?? []).map((t) => [t.id, t.status]));
  const mine = (links.data?.tasks ?? []).filter((t) => t.project_slug && brand.trackerProjects.includes(t.project_slug) && status.has(t.task_id) && !['done', 'archived'].includes(status.get(t.task_id)!));
  if (!brand.trackerProjects.length) return null;
  return (
    <section className="mb-3 rounded border border-[var(--rule)] p-2 text-sm" aria-label="Links">
      <span className="font-semibold">Projects: </span>
      {brand.trackerProjects.map((p, i) => <span key={p}>{i > 0 && ', '}<Link className="underline" to={`/projects?project=${p}`}>{p}</Link></span>)}
      {mine.length > 0 && (
        <div className="mt-1 text-xs">
          <span className="font-semibold">Open cards: </span>
          {mine.slice(0, 12).map((t) => <Link key={t.task_id} className="mr-2 underline" to={`/agents/board/${t.task_id}`} title={t.title}>{t.task_id}</Link>)}
          {mine.length > 12 && `and ${mine.length - 12} more`}
        </div>
      )}
    </section>
  );
}

function PostChip({ post, color, onSelect }: { post: MediaPost; color: (id: string) => string; onSelect: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onSelect(String(post.id))} title={`${post.network} · ${STATUS_LABEL[post.status]}`} className="inline-flex items-center gap-1 rounded border px-1 text-xs" style={{ borderColor: color(post.channelId) }}>
      <Marker status={post.status} />
      {post.network}
      {post.status !== 'queued' && <span className="text-[var(--ink-dim)]">{STATUS_LABEL[post.status]}</span>}
    </button>
  );
}

const hhmm = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const firstLine = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 60);

function EntryRow({ e, color, onSelect }: { e: Entry; color: (id: string) => string; onSelect: (id: string) => void }) {
  return (
    <div className="mb-1 rounded bg-[var(--paper-sunk)] p-1 text-xs" title={`${new Date(e.at).toISOString()} UTC`}>
      <div className="text-[var(--ink-dim)]">{hhmm(e.at)} {firstLine(e.posts[0]!.body)}</div>
      <div className="mt-0.5 flex flex-wrap gap-1">{e.posts.map((p) => <PostChip key={p.id} post={p} color={color} onSelect={onSelect} />)}</div>
    </div>
  );
}

function Grid({ view, anchor, from, entries, color, onSelect }: { view: View; anchor: Date; from: Date; entries: Entry[]; color: (id: string) => string; onSelect: (id: string) => void }) {
  const days = view === 'week' ? 7 : 42;
  const byDay = new Map<string, Entry[]>();
  for (const e of entries) byDay.set(localDay(new Date(e.at)), [...(byDay.get(localDay(new Date(e.at))) ?? []), e]);
  const today = localDay(new Date());
  return (
    // Phones get the list view; the grid needs width.
    <div className="hidden md:block">
      <div className="mb-1 grid grid-cols-7 gap-1 text-center text-xs text-[var(--ink-dim)]">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d}>{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: days }, (_, i) => {
          const d = addDays(from, i);
          const key = localDay(d);
          const other = view === 'month' && d.getMonth() !== anchor.getMonth();
          return (
            <div key={key} className={`min-h-24 rounded border p-1 ${key === today ? 'border-[var(--accent)]' : 'border-[var(--rule)]'} ${other ? 'opacity-50' : ''}`}>
              <div className="mb-1 text-xs text-[var(--ink-dim)]">{d.getDate()}</div>
              {(byDay.get(key) ?? []).map((e) => <EntryRow key={e.key} e={e} color={color} onSelect={onSelect} />)}
            </div>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-[var(--ink-faint)]">Hollow marker: draft. Half-filled: queued. Filled: posted. Red: failed. Times are in your zone; hover for UTC.</p>
    </div>
  );
}

function ListView({ entries, color, onSelect }: { entries: Entry[]; color: (id: string) => string; onSelect: (id: string) => void }) {
  const byDay = new Map<string, Entry[]>();
  for (const e of entries) byDay.set(localDay(new Date(e.at)), [...(byDay.get(localDay(new Date(e.at))) ?? []), e]);
  return (
    <div>
      {[...byDay].map(([day, es]) => (
        <section key={day} className="mb-3">
          <h3 className="mb-1 text-sm font-semibold">{new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</h3>
          {es.map((e) => <EntryRow key={e.key} e={e} color={color} onSelect={onSelect} />)}
        </section>
      ))}
    </div>
  );
}

/** One post: full text, options, links to the live post, draft file, card and style guide, and the owner's approve and cancel. */
function Detail({ post, channel, onClose }: { post: MediaPost; channel: MediaChannel | undefined; onClose: () => void }) {
  const qc = useQueryClient();
  const board = useQuery({ queryKey: ['hub-board', 'exo'], queryFn: () => api.board('exo'), staleTime: 30_000, retry: false, enabled: Boolean(post.card_id) });
  const card = board.data?.tasks.find((t) => t.id === post.card_id);
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['media-calendar'] });
  const approve = useMutation({ mutationFn: () => api.approvePost(post.id), onSuccess: refresh });
  const cancel = useMutation({ mutationFn: () => api.cancelPost(post.id), onSuccess: refresh });
  const [confirm, setConfirm] = useState(false);
  const err = approve.error ?? cancel.error;
  return (
    <aside className="w-full shrink-0 overflow-auto border-t border-[var(--rule)] p-3 text-sm md:w-96 md:border-l md:border-t-0" aria-label="Post detail">
      <div className="flex items-center gap-2">
        <Marker status={post.status} />
        <span className="font-semibold">{post.network}</span>
        <span className={`${chip} border-[var(--rule)]`}>{STATUS_LABEL[post.status]}</span>
        <button type="button" className="ml-auto text-[var(--ink-dim)]" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="mt-1 text-xs text-[var(--ink-dim)]" title={`${new Date(post.scheduled_for).toISOString()} UTC`}>
        {zoned(post.scheduled_for, null)}{channel?.handle ? ` · ${channel.handle}` : ''}
      </div>
      <pre className="mt-2 whitespace-pre-wrap break-words font-sans">{post.body}</pre>
      {post.mediaCount > 0 && <div className="mt-1 text-xs text-[var(--ink-dim)]">{post.mediaCount} media attached</div>}
      {Object.keys(post.options ?? {}).length > 0 && <pre className="mt-2 whitespace-pre-wrap text-xs text-[var(--ink-dim)]">{JSON.stringify(post.options, null, 2)}</pre>}
      {post.status === 'failed' && post.last_error && <div className="mt-2 text-xs text-[var(--warn)]">{post.last_error}</div>}
      <dl className="mt-2 space-y-1 text-xs">
        {post.remote_url && <div><dt className="inline text-[var(--ink-dim)]">Live: </dt><dd className="inline"><a className="underline" href={post.remote_url} target="_blank" rel="noreferrer">{post.remote_url}</a></dd></div>}
        {post.source_path && <div><dt className="inline text-[var(--ink-dim)]">Draft file: </dt><dd className="inline"><Link className="underline" to={`/file/${post.source_path}`}>{post.source_path}</Link></dd></div>}
        {post.card_id && <div><dt className="inline text-[var(--ink-dim)]">Card: </dt><dd className="inline"><Link className="underline" to={`/agents/board/${post.card_id}`}>{post.card_id}</Link>{card ? ` ${card.title} (${card.status})` : ''}</dd></div>}
        {channel?.style_guide && !channel.styleGuideMissing && <div><dt className="inline text-[var(--ink-dim)]">Style guide: </dt><dd className="inline"><Link className="underline" to={`/file/${channel.style_guide}`}>{channel.style_guide.split('/').pop()}</Link></dd></div>}
      </dl>
      <div className="mt-3 flex items-center gap-2">
        {post.status === 'draft' && <button type="button" disabled={approve.isPending} onClick={() => approve.mutate()} className="rounded bg-[var(--accent)] px-2 py-0.5 text-white disabled:opacity-50">Approve</button>}
        {(post.status === 'draft' || post.status === 'queued') && (confirm
          ? <><button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()} className="rounded border border-[var(--warn)] px-2 py-0.5 text-[var(--warn)]">Confirm cancel</button><button type="button" className="text-xs text-[var(--ink-dim)]" onClick={() => setConfirm(false)}>keep</button></>
          : <button type="button" onClick={() => setConfirm(true)} className="rounded border border-[var(--rule)] px-2 py-0.5">Cancel post</button>)}
      </div>
      {err && <div className="mt-2 text-xs text-[var(--warn)]">{err.message}</div>}
    </aside>
  );
}
