import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { tvApi, type TvEpisode } from '../lib/api.js';
import { zoned } from '../lib/time.js';

/**
 * TV: the vault's own video channel. The newest episode starts on its own,
 * the playlist runs newest to oldest, and loops; a scrollable strip under the
 * player picks any episode. `?kiosk=1` is the TV mode a kiosk opens: no app
 * chrome, no strip, same autoplay loop. The list refetches every few minutes,
 * so an episode a scheduled job adds joins the loop without a reload. Show
 * names come from `tv.shows` in secondbrain.json.
 */

const REFETCH_MS = 5 * 60_000;

export const showLabel = (show: string, shows: Record<string, string> = {}): string => shows[show] ?? show;

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** The id that plays after `current`, wrapping to the newest at the end. */
export function nextId(playable: TvEpisode[], current: string | null): string | null {
  if (playable.length === 0) return null;
  const i = playable.findIndex((e) => e.id === current);
  return playable[(i + 1) % playable.length]!.id;
}

export default function Tv() {
  const [params] = useSearchParams();
  const kiosk = params.get('kiosk') === '1';
  const episodes = useQuery({ queryKey: ['tv'], queryFn: tvApi.episodes, refetchInterval: REFETCH_MS });
  const playable = useMemo(() => (episodes.data?.episodes ?? []).filter((e) => e.video), [episodes.data]);
  const [current, setCurrent] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // Start on the newest playable episode; keep the viewer's pick across refetches.
  useEffect(() => {
    if (playable.length === 0) return;
    if (!current || !playable.some((e) => e.id === current)) setCurrent(playable[0]!.id);
  }, [playable, current]);

  const episode = playable.find((e) => e.id === current) ?? null;

  const tryPlay = useCallback(() => {
    // jsdom's play() returns undefined; a browser returns a promise that
    // rejects when autoplay with sound needs a gesture. Then show a button.
    const p = videoRef.current?.play() as Promise<void> | undefined;
    p?.then(() => setBlocked(false)).catch(() => setBlocked(true));
  }, []);

  useEffect(() => {
    if (episode) tryPlay();
  }, [episode, tryPlay]);

  // Move to the next episode. With only one playable episode the id doesn't
  // change, so nothing would re-render: restart the same video instead, or the
  // loop stops after one play. `reload` refetches the file after a load error.
  const advance = useCallback(
    (reload: boolean) => {
      const next = nextId(playable, current);
      if (next && next !== current) {
        setCurrent(next);
        return;
      }
      const v = videoRef.current;
      if (!v) return;
      if (reload) v.load?.();
      else v.currentTime = 0;
      tryPlay();
    },
    [playable, current, tryPlay],
  );

  // A file that fails to load (B2 hiccup, a half-uploaded render) must not
  // freeze the TV: skip it after a pause, or retry the only one slowly.
  const retryRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(retryRef.current), [current]);
  const onVideoError = useCallback(() => {
    clearTimeout(retryRef.current);
    retryRef.current = setTimeout(() => advance(true), playable.length > 1 ? 3_000 : 30_000);
  }, [advance, playable.length]);

  // Keep the playing card in view on the strip.
  useEffect(() => {
    if (!current) return;
    const cards = stripRef.current?.querySelectorAll<HTMLElement>('[data-id]') ?? [];
    for (const card of cards) {
      // jsdom has no scrollIntoView; episode ids never contain quotes.
      if (card.dataset['id'] === current) card.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }
  }, [current]);

  if (episodes.isError) {
    return <div className="p-4 text-[var(--ink-dim)]">TV is unavailable: {String(episodes.error)}</div>;
  }

  const player = (
    <div className={`relative bg-black ${kiosk ? 'h-full w-full' : 'aspect-video w-full overflow-hidden rounded'}`}>
      {episode ? (
        <video
          key={episode.id}
          ref={videoRef}
          src={episode.video ?? undefined}
          controls={!kiosk}
          autoPlay
          playsInline
          onEnded={() => advance(false)}
          onError={onVideoError}
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[var(--paper)]">
          {episodes.isLoading ? 'Loading TV…' : 'No playable episode yet.'}
        </div>
      )}
      {blocked && episode && (
        <button
          type="button"
          onClick={tryPlay}
          className="absolute inset-0 flex items-center justify-center bg-black/60 text-xl text-white"
        >
          ▶ Start TV
        </button>
      )}
    </div>
  );

  if (kiosk) {
    return (
      <div className="fixed inset-0 z-50 bg-black" data-testid="kiosk">
        {player}
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">TV</h1>
        <span className="text-sm text-[var(--ink-dim)]">
          The internal channel. Newest first, then the rest, on a loop. {playable.length} playable of {episodes.data?.episodes.length ?? 0}.
        </span>
        <Link to="/tv?kiosk=1" className="ml-auto text-sm underline">TV mode</Link>
      </div>
      {player}
      {episode && (
        <div className="mt-2 flex flex-wrap items-baseline gap-2 text-sm">
          <span className="rounded border px-1.5 py-0.5 text-xs">{showLabel(episode.show, episodes.data?.shows)}</span>
          <span className="font-medium">{episode.title}</span>
          <span className="text-[var(--ink-dim)]">
            generated {episode.generated_at ? zoned(episode.generated_at, 'Asia/Tokyo') : 'unknown'}
            {episode.duration_s !== null && ` · ${formatDuration(episode.duration_s)}`}
            {episode.source && ` · ${episode.source === 'local' ? 'this Mac' : 'B2'}`}
          </span>
          <Link to={`/file/${episode.note}`} className="underline">episode note</Link>
          <button type="button" onClick={() => setCurrent(nextId(playable, current))} className="ml-auto underline">
            next ▸
          </button>
        </div>
      )}

      <h2 className="mt-5 mb-2 text-sm font-semibold uppercase tracking-wide text-[var(--ink-dim)]">Episodes</h2>
      <div ref={stripRef} data-testid="strip" className="flex gap-3 overflow-x-auto pb-3">
        {(episodes.data?.episodes ?? []).map((e: TvEpisode) => {
          const playing = e.id === current;
          const inner = (
            <>
              <div className="flex items-baseline gap-2">
                <span className="rounded border px-1.5 py-0.5 text-[0.65rem]">{showLabel(e.show, episodes.data?.shows)}</span>
                {playing && <span className="text-[0.65rem] text-[var(--ink-dim)]">now playing</span>}
                {!e.video && <span className="text-[0.65rem] text-[var(--ink-dim)]">not playable here</span>}
              </div>
              <div className={`mt-1 line-clamp-2 text-sm ${playing ? 'font-semibold' : ''}`}>{e.title}</div>
              <div className="mt-1 text-xs text-[var(--ink-dim)]">
                {e.generated_at ? zoned(e.generated_at, 'Asia/Tokyo') : ''}
                {e.duration_s !== null && ` · ${formatDuration(e.duration_s)}`}
              </div>
            </>
          );
          const cls = `w-64 shrink-0 rounded border p-3 text-left ${playing ? 'border-[var(--ink)] bg-[var(--paper-sunk)]' : 'border-[var(--rule)]'}`;
          return e.video ? (
            <button key={e.id} type="button" data-id={e.id} onClick={() => setCurrent(e.id)} className={cls}>
              {inner}
            </button>
          ) : (
            <div key={e.id} data-id={e.id} className={`${cls} opacity-60`} title="The MP4 is not on this machine and not mirrored to B2 yet">
              {inner}
              <Link to={`/file/${e.note}`} className="mt-1 block text-xs underline">note</Link>
            </div>
          );
        })}
        {episodes.data && episodes.data.episodes.length === 0 && (
          <div className="py-2 text-sm text-[var(--ink-dim)]">No episodes under {episodes.data?.episodesDir ?? 'the episodes folder'}/ yet.</div>
        )}
      </div>
    </div>
  );
}
