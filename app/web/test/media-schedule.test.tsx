import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import MediaSchedule, { groupPosts, rangeFor } from '../src/routes/MediaSchedule.js';
import type { MediaBrandResult, MediaCalendar, MediaChannel, MediaPost } from '../src/lib/api.js';

const channel = (over: Partial<MediaChannel>): MediaChannel => ({
  id: 'instagram', network: 'instagram', handle: '@argo', url: 'https://www.instagram.com/argo/', urlUnconfirmed: false,
  posting: 'buffer', account_id: 1, style_guide: 'media/reel.md', styleGuideMissing: false,
  account: { state: 'connected', tokenExpiresInDays: null, provider: 'instagram', transport: 'buffer' },
  counts: { draft: 1, queued: 0, posted: 1, failed: 0 }, ...over,
});

const post = (over: Partial<MediaPost>): MediaPost => ({
  id: 1, account_id: 1, channelId: 'instagram', network: 'instagram', body: 'reel one', options: {}, status: 'posted',
  scheduled_for: '2026-10-21T09:00:00.000Z', posted_at: '2026-10-21T09:01:00.000Z', remote_url: 'https://instagram.com/reel/a',
  last_error: null, card_id: 't_0944bc6c', source_path: 'media/social-posts/one.md', hasMedia: false, mediaCount: 0, ...over,
});

const CHANNELS = [channel({}), channel({ id: 'youtube', network: 'youtube', handle: '@argo-yt', url: null, urlUnconfirmed: true, account_id: 2, counts: { draft: 0, queued: 0, posted: 0, failed: 0 } })];
const BRAND: MediaBrandResult = {
  ok: true, slug: 'argo', name: 'Argo', config: 'media/media-brand.md', trackerProjects: ['argo-reel'],
  styleGuides: [{ path: 'media/long-form.md', missing: false }], channels: CHANNELS, warnings: ['channel youtube: profile not confirmed yet'],
};
const BROKEN: MediaBrandResult = { ok: false, slug: 'other', config: 'media/other.md', error: { file: 'media/other.md', line: 3, message: 'front matter does not parse' } };

const CAL: MediaCalendar = {
  brand: 'argo', from: '', to: '', channels: CHANNELS,
  posts: [
    post({ id: 1 }),
    post({ id: 2, channelId: 'youtube', network: 'youtube', status: 'draft', remote_url: null }),
    post({ id: 3, status: 'canceled', scheduled_for: '2026-10-22T09:00:00.000Z', source_path: null, body: 'dropped' }),
  ],
};

let calls: { url: string; method: string }[] = [];

function mount(path: string, brands: MediaBrandResult[] = [BRAND, BROKEN]) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET' });
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/api/media/brands/argo/calendar')) return reply(CAL);
    if (u.includes('/api/media/brands')) return reply({ brands });
    if (u.includes('/approve')) return reply({ post: post({ status: 'queued' }) });
    return reply({ error: { message: 'not available' } }, 503);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <MediaSchedule />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('helpers', () => {
  it('groups posts from one draft file at one time into one entry, others stay alone', () => {
    const entries = groupPosts(CAL.posts);
    expect(entries.map((e) => e.posts.map((p) => p.id))).toEqual([[1, 2], [3]]);
  });

  it('computes the visible range: week from Monday, list for the month, 6 weeks for the month grid', () => {
    const wed = new Date(2026, 9, 21);
    expect(rangeFor('week', wed).from).toEqual(new Date(2026, 9, 19));
    expect(rangeFor('list', wed)).toMatchObject({ from: new Date(2026, 9, 1), to: new Date(2026, 10, 1) });
    const m = rangeFor('month', wed);
    expect(m.from.getDay()).toBe(1);
    expect((m.to.getTime() - m.from.getTime()) / 86_400_000).toBeGreaterThanOrEqual(41);
  });
});

describe('MediaSchedule', () => {
  it('shows channels with posting badges, links and an unconfirmed profile, and asks for the brand calendar', async () => {
    mount('/media-schedule?brand=argo&view=list&date=2026-10-21');
    expect(await screen.findByText('@argo')).toBeTruthy();
    // Both channels post by Buffer, and the unconfirmed profile is named in the row and in the warnings.
    expect(screen.getAllByText('api: buffer')).toHaveLength(2);
    expect(screen.getAllByText(/profile not confirmed/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('link', { name: '@argo' }).getAttribute('href')).toBe('https://www.instagram.com/argo/');
    expect(screen.getAllByRole('link', { name: 'style guide' })[0]!.getAttribute('href')).toBe('/file/media/reel.md');
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/media/brands/argo/calendar?from='))).toBe(true));
  });

  it('hides canceled posts until asked', async () => {
    mount('/media-schedule?brand=argo&view=list&date=2026-10-21');
    await screen.findAllByText(/reel one/);
    expect(screen.queryByText(/dropped/)).toBeNull();
    cleanup();
    mount('/media-schedule?brand=argo&view=list&date=2026-10-21&canceled=1');
    expect(await screen.findByText(/dropped/)).toBeTruthy();
  });

  it('opens a draft in the side panel with its draft file and card, and approves it', async () => {
    mount('/media-schedule?brand=argo&view=list&date=2026-10-21&post=2');
    expect(await screen.findByRole('complementary', { name: 'Post detail' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'media/social-posts/one.md' }).getAttribute('href')).toBe('/file/media/social-posts/one.md');
    expect(screen.getByRole('link', { name: 't_0944bc6c' }).getAttribute('href')).toBe('/agents/board/t_0944bc6c');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/social/posts/2/approve'))).toBe(true));
  });

  it('shows an error card naming the file and line for a broken brand', async () => {
    mount('/media-schedule?brand=other', [BROKEN, BRAND]);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('media/other.md');
    expect(alert.textContent).toContain('line 3');
    expect(calls.some((c) => c.url.includes('/calendar'))).toBe(false);
  });

  it('says so when no brand is configured', async () => {
    mount('/media-schedule', []);
    expect(await screen.findByText(/No brands are set up/)).toBeTruthy();
  });
});
