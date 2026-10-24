import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { collectVaultRefs, remarkVaultPaths, splitVaultPaths } from '../src/lib/vaultRefs.js';
import { remarkWikilink } from '../src/lib/wikilink.js';
import { VaultMarkdown } from '../src/components/VaultMarkdown.js';

const paths = (s: string) => splitVaultPaths(s).flatMap((p) => (p.type === 'path' ? [p.path] : []));
const run = (md: string): string =>
  unified().use(remarkParse).use(remarkWikilink).use(remarkVaultPaths).use(remarkStringify).processSync(md).toString();

// The shapes real bot results on board exo use (2026-10-19).
const RESULT =
  'Added section 8 to Research/ai/model-routing-by-role-research.md: qualifying cards.\n\n' +
  'RECEIPT check_note `Areas/argo/media/linkedin-posts/2026-10-19_how-secondbrain-works.md` PASS\n\n' +
  'See [[jev-performance-and-cost-plan-research]] and [[ghost-note]]. Live: https://www.linkedin.com/feed/update/x.md';

describe('splitVaultPaths', () => {
  it('finds bare paths, keeping trailing punctuation outside', () => {
    expect(paths('written to Research/ai/x-research.md.')).toEqual(['Research/ai/x-research.md']);
    expect(paths('(see Projects/a/dev-log/README.md)')).toEqual(['Projects/a/dev-log/README.md']);
    expect(paths('run .agents/skills/v/scripts/check_note.py now')).toEqual(['.agents/skills/v/scripts/check_note.py']);
  });

  it('leaves URLs, relative paths and versions alone', () => {
    expect(paths('https://host.com/a/b.md')).toEqual([]);
    expect(paths('../x/y.md and ./z/w.md')).toEqual([]);
    expect(paths('v0.22.2 and 3.5 USD and file.md')).toEqual([]);
  });
});

describe('remarkVaultPaths', () => {
  it('links bare and whole-backticked paths, not partial code or wikilink text', () => {
    const out = run(RESULT);
    expect(out).toContain('[Research/ai/model-routing-by-role-research.md](vaultpath:Research/ai/model-routing-by-role-research.md)');
    expect(out).toContain('[`Areas/argo/media/linkedin-posts/2026-10-19_how-secondbrain-works.md`](vaultpath:');
    expect(run('`cat Research/a/b.md`')).not.toContain('vaultpath:');
    expect(run('[[Research/a/b.md]]')).not.toContain('vaultpath:');
  });

  it('collects every ref the renderer will resolve', () => {
    expect(collectVaultRefs(RESULT)).toEqual([
      'Areas/argo/media/linkedin-posts/2026-10-19_how-secondbrain-works.md',
      'Research/ai/model-routing-by-role-research.md',
      'ghost-note',
      'jev-performance-and-cost-plan-research',
    ]);
  });
});

describe('VaultMarkdown', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('links resolved refs to the note page and marks a dead wikilink', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ resolved: {
        'Research/ai/model-routing-by-role-research.md': 'Research/ai/model-routing-by-role-research.md',
        'Areas/argo/media/linkedin-posts/2026-10-19_how-secondbrain-works.md': null,
        'jev-performance-and-cost-plan-research': 'Research/ai/jev-performance-and-cost-plan-research.md',
        'ghost-note': null,
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter><VaultMarkdown text={RESULT} /></MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(container.querySelector('a[href="/file/Research/ai/model-routing-by-role-research.md"]')).toBeTruthy());
    expect(calls[0]).toMatch(/^\/api\/file\/resolve\?ref=/);
    expect(screen.getByText('jev-performance-and-cost-plan-research').closest('a')?.getAttribute('href'))
      .toBe('/file/Research/ai/jev-performance-and-cost-plan-research.md');
    // An unresolved bare path is plain text, an unresolved wikilink a visible gap.
    expect(screen.getByText('Areas/argo/media/linkedin-posts/2026-10-19_how-secondbrain-works.md').closest('a')).toBeNull();
    expect(screen.getByText('ghost-note').className).toBe('wikilink-dead');
    expect(container.querySelector('a[href^="https://www.linkedin.com"]')).toBeTruthy();
  });

  it('opens a Preview modal for a resolved path and dismisses it with Esc, the close button and the backdrop', async () => {
    const path = 'Research/ai/x-research.md';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      const body = u.startsWith('/api/file/resolve')
        ? { resolved: { [path]: path } }
        : { file: { path, name: 'x-research.md', title: 'X research', ext: '.md', size_bytes: 5, mtime: '2026-10-21T00:00:00Z', is_markdown: true, body: 'Hello preview', parent_path: 'Research/ai' },
            frontmatter: {}, tags: [], links: [], backlinks: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter><VaultMarkdown text={`Wrote ${path}.`} /></MemoryRouter>
      </QueryClientProvider>,
    );

    const button = await screen.findByRole('button', { name: 'Preview' });
    fireEvent.click(button);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(await screen.findByText('Hello preview')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(button);
    fireEvent.click(await screen.findByTestId('preview-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
