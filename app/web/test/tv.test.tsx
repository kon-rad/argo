import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Tv, { formatDuration, nextId, showLabel } from '../src/routes/Tv.js';
import type { TvEpisode } from '../src/lib/api.js';

const ep = (id: string, title: string, show: string, video: string | null, generated_at: string): TvEpisode => ({
  id, title, show, generated_at, duration_s: 500, voice: 'am_michael',
  note: `tv/episodes/${id}/episode.md`, video, source: video ? 'local' : null,
});

// Newest first, as the API returns them. The middle one has no media anywhere.
const EPISODES = {
  episodes: [
    ep('2026-10-17_c', 'Episode C (newest)', 'news', '/api/tv/media/c', '2026-10-17T09:00:00+09:00'),
    ep('2026-10-16_b', 'Episode B (no media)', 'research', null, '2026-10-16T09:00:00+09:00'),
    ep('2026-10-15_a', 'Episode A (oldest)', 'news', '/api/tv/media/a', '2026-10-15T00:45:00+09:00'),
  ],
};

function mount(path = '/tv') {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(EPISODES), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Tv />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const video = (container: HTMLElement) => container.querySelector('video');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Tv helpers', () => {
  it('labels shows and formats durations', () => {
    expect(showLabel('news', { news: 'The weekly report' })).toBe('The weekly report');
    expect(showLabel('other')).toBe('other');
    expect(formatDuration(520)).toBe('8:40');
    expect(formatDuration(null)).toBe('');
  });

  it('nextId walks newest to oldest and wraps to the newest', () => {
    const playable = EPISODES.episodes.filter((e) => e.video);
    expect(nextId(playable, '2026-10-17_c')).toBe('2026-10-15_a');
    expect(nextId(playable, '2026-10-15_a')).toBe('2026-10-17_c');
    expect(nextId(playable, null)).toBe('2026-10-17_c');
    expect(nextId([], null)).toBeNull();
  });
});

describe('Tv page', () => {
  it('starts on the newest playable episode with autoplay and shows the strip', async () => {
    const { container } = mount();
    await waitFor(() => expect(video(container)).toBeTruthy());
    expect(video(container)?.getAttribute('src')).toBe('/api/tv/media/c');
    expect(video(container)?.hasAttribute('autoplay')).toBe(true);
    expect(video(container)?.hasAttribute('controls')).toBe(true);
    const strip = screen.getByTestId('strip');
    expect(strip.querySelectorAll('[data-id]').length).toBe(3);
    expect(screen.getByText('now playing')).toBeTruthy();
    expect(screen.getByText('not playable here')).toBeTruthy();
  });

  it('loops: after the oldest ends it plays the newest again, skipping the unplayable one', async () => {
    const { container } = mount();
    await waitFor(() => expect(video(container)).toBeTruthy());
    fireEvent(video(container)!, new Event('ended'));
    await waitFor(() => expect(video(container)?.getAttribute('src')).toBe('/api/tv/media/a'));
    fireEvent(video(container)!, new Event('ended'));
    await waitFor(() => expect(video(container)?.getAttribute('src')).toBe('/api/tv/media/c'));
  });

  it('loops a single playable episode instead of stopping after it', async () => {
    const one = { episodes: [EPISODES.episodes[0]!] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(one), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/tv?kiosk=1']}>
          <Tv />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(video(container)).toBeTruthy());
    const v = video(container)!;
    const play = vi.fn(() => Promise.resolve());
    Object.defineProperty(v, 'play', { value: play, configurable: true });
    v.currentTime = 42;
    fireEvent(v, new Event('ended'));
    expect(play).toHaveBeenCalled();
    expect(v.currentTime).toBe(0);
    expect(video(container)).toBe(v);
  });

  it('skips an episode whose file fails to load', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = mount('/tv?kiosk=1');
      await waitFor(() => expect(video(container)).toBeTruthy());
      fireEvent(video(container)!, new Event('error'));
      expect(video(container)?.getAttribute('src')).toBe('/api/tv/media/c');
      await vi.advanceTimersByTimeAsync(3_100);
      await waitFor(() => expect(video(container)?.getAttribute('src')).toBe('/api/tv/media/a'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a card on the strip selects that episode', async () => {
    const { container } = mount();
    await waitFor(() => expect(video(container)).toBeTruthy());
    fireEvent.click(screen.getByText('Episode A (oldest)'));
    await waitFor(() => expect(video(container)?.getAttribute('src')).toBe('/api/tv/media/a'));
  });

  it('kiosk mode is the bare full-screen player: autoplay, no controls, no strip', async () => {
    const { container } = mount('/tv?kiosk=1');
    await waitFor(() => expect(video(container)).toBeTruthy());
    expect(screen.getByTestId('kiosk')).toBeTruthy();
    expect(video(container)?.hasAttribute('controls')).toBe(false);
    expect(video(container)?.hasAttribute('autoplay')).toBe(true);
    expect(screen.queryByTestId('strip')).toBeNull();
  });
});
