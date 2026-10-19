import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Media, { kindIcon, wrapIndex } from '../src/routes/Media.js';
import type { MediaItem, MediaResponse } from '../src/lib/api.js';

const item = (name: string, kind: MediaItem['kind'], source: MediaItem['source'] = 'local'): MediaItem => ({
  path: `Areas/x/${name}${source === 'b2' ? '.b2.md' : ''}`, folder: 'Areas/x', name, ext: name.slice(name.lastIndexOf('.')),
  kind, size_bytes: 2048, mtime: '2026-10-19T00:00:00Z', source, available: true,
  url: `/api/${source === 'b2' ? 'b2' : 'raw'}?path=${encodeURIComponent(`Areas/x/${name}`)}`,
});

const RESPONSE: MediaResponse = {
  items: [item('cat.jpg', 'image'), item('talk.mp4', 'video', 'b2'), item('song.mp3', 'audio')],
  total: 3,
  has_more: false,
  counts: { image: 1, video: 1, audio: 1 },
  folders: [{ path: 'Areas/x', count: 3 }],
};

let calls: string[] = [];

function mount(path = '/media') {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify(RESPONSE), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Media />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Media helpers', () => {
  it('wraps the lightbox index both ways', () => {
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(0, -1, 3)).toBe(2);
    expect(wrapIndex(0, 1, 0)).toBe(0);
    expect(kindIcon('audio')).toBe('♪');
  });
});

describe('Media page', () => {
  it('shows the counts on the tabs and a card per file', async () => {
    const { container } = mount();
    await screen.findByText('cat.jpg');
    expect(screen.getByRole('tab', { name: /All 3/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Video 1/ })).toBeTruthy();
    expect(container.querySelector('img[src="/api/raw?path=Areas%2Fx%2Fcat.jpg"]')).toBeTruthy();
    expect(container.querySelector('video[preload="metadata"]')).toBeTruthy();
    expect(screen.getByText(/B2$/)).toBeTruthy();
  });

  it('puts filters in the request', async () => {
    mount('/media?kind=video&path=Areas/x&q=talk&sort=name');
    await screen.findByText('talk.mp4');
    const url = calls[0]!;
    expect(url).toContain('/api/media?');
    expect(url).toContain('kind=video');
    expect(url).toContain('path=Areas%2Fx');
    expect(url).toContain('q=talk');
    expect(url).toContain('sort=name');
  });

  it('opens a lightbox that steps with the arrow keys and closes on Escape', async () => {
    mount();
    fireEvent.click(await screen.findByText('cat.jpg'));
    const dialog = await screen.findByRole('dialog', { name: 'cat.jpg' });
    expect(dialog.querySelector('img')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    const video = await screen.findByRole('dialog', { name: 'talk.mp4' });
    expect(video.querySelector('video[controls]')).toBeTruthy();
    expect(screen.getByText(/streaming from B2/)).toBeTruthy();

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    const audio = await screen.findByRole('dialog', { name: 'song.mp3' });
    expect(audio.querySelector('audio[controls]')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
