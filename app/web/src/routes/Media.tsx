import { useCallback, useEffect, useState } from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { formatBytes, mediaApi, type MediaItem, type MediaKind, type MediaQuery } from '../lib/api.js';

/**
 * Media: every image, video and audio file in the vault as one gallery, with
 * a lightbox that plays video and audio. Filters live in the URL (kind, path,
 * q, sort) so a filtered view can be linked. Files on this machine come from
 * /api/raw; on a server, `.b2.md` stubs stream from B2 through /api/b2.
 */

const PAGE = 120;
const TABS: { kind: 'all' | MediaKind; label: string }[] = [
  { kind: 'all', label: 'All' },
  { kind: 'image', label: 'Images' },
  { kind: 'video', label: 'Video' },
  { kind: 'audio', label: 'Audio' },
];

export const kindIcon = (kind: MediaKind): string => ({ image: '▣', video: '▶', audio: '♪' })[kind];

/** The index after `i` in a list of `n`, wrapping; `step` is +1 or -1. */
export function wrapIndex(i: number, step: number, n: number): number {
  return n === 0 ? 0 : (i + step + n) % n;
}

export default function Media() {
  const [params, setParams] = useSearchParams();
  const kind = (params.get('kind') ?? 'all') as 'all' | MediaKind;
  const path = params.get('path') ?? '';
  const q = params.get('q') ?? '';
  const sort = (params.get('sort') ?? 'new') as NonNullable<MediaQuery['sort']>;
  const [draft, setDraft] = useState(q);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => setDraft(q), [q]);

  const set = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params);
      if (value && !(key === 'kind' && value === 'all') && !(key === 'sort' && value === 'new')) next.set(key, value);
      else next.delete(key);
      setParams(next, { replace: true });
      setOpen(null);
    },
    [params, setParams],
  );

  const media = useInfiniteQuery({
    queryKey: ['media', kind, path, q, sort],
    queryFn: ({ pageParam }) => mediaApi.list({ kind, path, q, sort, limit: PAGE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.has_more ? pages.length * PAGE : undefined),
    placeholderData: keepPreviousData,
  });
  const items = media.data?.pages.flatMap((p) => p.items) ?? [];
  const first = media.data?.pages[0];
  const counts = first?.counts ?? { image: 0, video: 0, audio: 0 };
  const all = counts.image + counts.video + counts.audio;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--rule)] px-4 py-2">
        <h1 className="mr-2 text-xl font-semibold">Media</h1>
        <div className="flex gap-1" role="tablist">
          {TABS.map((t) => {
            const n = t.kind === 'all' ? all : counts[t.kind];
            const active = t.kind === kind;
            return (
              <button
                key={t.kind}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => set('kind', t.kind)}
                className={`rounded px-2 py-1 text-sm ${active ? 'bg-[var(--paper-sunk)] text-[var(--ink)]' : 'text-[var(--ink-dim)] hover:text-[var(--ink)]'}`}
              >
                {t.label} <span className="text-xs text-[var(--ink-dim)]">{first ? n : ''}</span>
              </button>
            );
          })}
        </div>
        <select
          aria-label="Folder"
          value={path}
          onChange={(e) => set('path', e.target.value)}
          className="max-w-[18rem] rounded border border-[var(--rule)] bg-transparent px-2 py-1 text-sm"
        >
          <option value="">Whole vault</option>
          {path && !first?.folders.some((f) => f.path === path) && <option value={path}>{path}</option>}
          {(first?.folders ?? []).map((f) => (
            <option key={f.path} value={f.path}>
              {f.path || '(vault root)'} ({f.count})
            </option>
          ))}
        </select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            set('q', draft.trim());
          }}
        >
          <input
            aria-label="Filter by name"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="name contains…"
            className="w-44 rounded border border-[var(--rule)] bg-transparent px-2 py-1 text-sm"
          />
        </form>
        <select
          aria-label="Sort"
          value={sort}
          onChange={(e) => set('sort', e.target.value)}
          className="rounded border border-[var(--rule)] bg-transparent px-2 py-1 text-sm"
        >
          <option value="new">Newest</option>
          <option value="name">Name</option>
          <option value="size">Largest</option>
        </select>
        <span className="ml-auto text-sm text-[var(--ink-dim)]">
          {first ? `${items.length} of ${first.total}` : ''}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {media.isError && <div className="text-[var(--ink-dim)]">Media is unavailable: {String(media.error)}</div>}
        {media.isLoading && <div className="text-[var(--ink-dim)]">Loading…</div>}
        {first && items.length === 0 && <div className="text-[var(--ink-dim)]">No media here.</div>}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3" data-testid="grid">
          {items.map((item, i) => (
            <button
              key={item.path}
              type="button"
              onClick={() => setOpen(i)}
              className="group overflow-hidden rounded border border-[var(--rule)] text-left hover:border-[var(--ink)]"
              title={item.path}
            >
              <Thumb item={item} />
              <div className="px-2 py-1.5">
                <div className="truncate text-sm">{item.name}</div>
                <div className="truncate text-xs text-[var(--ink-dim)]">
                  {item.folder}
                  {item.size_bytes !== null && ` · ${formatBytes(item.size_bytes)}`}
                  {item.source === 'b2' && ' · B2'}
                </div>
              </div>
            </button>
          ))}
        </div>
        {media.hasNextPage && (
          <div className="mt-4 text-center">
            <button
              type="button"
              disabled={media.isFetchingNextPage}
              onClick={() => void media.fetchNextPage()}
              className="rounded border border-[var(--rule)] px-3 py-1 text-sm"
            >
              {media.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>

      {open !== null && items[open] && (
        <Lightbox
          item={items[open]}
          position={`${open + 1} / ${first?.total ?? items.length}`}
          onClose={() => setOpen(null)}
          onStep={(step) => setOpen((i) => (i === null ? null : wrapIndex(i, step, items.length)))}
        />
      )}
    </div>
  );
}

function Thumb({ item }: { item: MediaItem }) {
  const box = 'relative flex aspect-square w-full items-center justify-center overflow-hidden bg-[var(--paper-sunk)]';
  if (!item.available) {
    return (
      <div className={`${box} flex-col gap-1 text-center text-xs text-[var(--ink-dim)]`}>
        <span className="text-2xl" aria-hidden>{kindIcon(item.kind)}</span>
        not on this machine
      </div>
    );
  }
  if (item.kind === 'image') {
    return (
      <div className={box}>
        <img src={item.url} alt={item.name} loading="lazy" decoding="async" className="h-full w-full object-cover" />
      </div>
    );
  }
  if (item.kind === 'video') {
    return (
      <div className={box}>
        {/* #t= asks for a frame a moment in, which is rarely black; metadata only, no download of the whole file. */}
        <video src={`${item.url}#t=0.5`} preload="metadata" muted playsInline className="h-full w-full object-cover" />
        <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1.5 text-xs text-white">▶</span>
      </div>
    );
  }
  return (
    <div className={`${box} text-4xl text-[var(--ink-dim)]`} aria-hidden>
      {kindIcon(item.kind)}
    </div>
  );
}

function Lightbox({
  item,
  position,
  onClose,
  onStep,
}: {
  item: MediaItem;
  position: string;
  onClose: () => void;
  onStep: (step: number) => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') onStep(1);
      else if (e.key === 'ArrowLeft') onStep(-1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onStep]);

  const download = `${item.url}&download=1`;
  return (
    <div
      role="dialog"
      aria-label={item.name}
      className="fixed inset-0 z-50 flex flex-col bg-black/90 text-white"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-4 py-2 text-sm">
        <span className="font-medium">{item.name}</span>
        <span className="text-white/60">
          {position} · {item.folder}
          {item.size_bytes !== null && ` · ${formatBytes(item.size_bytes)}`}
          {item.source === 'b2' && ' · streaming from B2'}
        </span>
        <Link to={`/file/${item.path}`} className="underline" onClick={onClose}>
          open in vault
        </Link>
        <a href={download} className="underline">
          download
        </a>
        <button type="button" onClick={onClose} className="ml-auto rounded px-2 py-1 hover:bg-white/10" aria-label="Close">
          ✕
        </button>
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <button type="button" aria-label="Previous" onClick={() => onStep(-1)} className="absolute left-2 rounded px-3 py-6 text-2xl hover:bg-white/10">
          ‹
        </button>
        {!item.available && (
          <div className="text-center text-white/70">
            Indexed, but not on this machine's disk. It may only exist on the server that scans the vault.
          </div>
        )}
        {item.available && item.kind === 'image' && <img key={item.path} src={item.url} alt={item.name} className="max-h-full max-w-full object-contain" />}
        {item.available && item.kind === 'video' && (
          <video key={item.path} src={item.url} controls autoPlay playsInline className="max-h-full max-w-full" />
        )}
        {item.available && item.kind === 'audio' && (
          <div className="flex w-full max-w-xl flex-col items-center gap-4">
            <div className="text-7xl text-white/50" aria-hidden>
              ♪
            </div>
            <audio key={item.path} src={item.url} controls autoPlay className="w-full" />
          </div>
        )}
        <button type="button" aria-label="Next" onClick={() => onStep(1)} className="absolute right-2 rounded px-3 py-6 text-2xl hover:bg-white/10">
          ›
        </button>
      </div>
    </div>
  );
}
