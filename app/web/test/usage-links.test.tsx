import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SessionContent } from '../src/routes/usage/SessionContent.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(text: string, literal = false) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(
    String(input).includes('/org/chart') ? { agents: [{ name: 'guide' }] }
      : { resolved: { 'Research/demo.md': 'Research/demo.md', demo: 'Research/demo.md' } },
  ), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><SessionContent text={text} literal={literal} /></MemoryRouter></QueryClientProvider>);
}
describe('session reference navigation', () => {
  it('links tickets, roster names, mentions and resolved notes in prose', async () => {
    setup('guide @guide t_1234abcd Research/demo.md [[demo]] [open ticket](/board/t_abcdef12)');
    expect((await screen.findByRole('link', { name: 'guide' })).getAttribute('href')).toBe('/org/agents/guide');
    expect((await screen.findByRole('link', { name: '@guide' })).getAttribute('href')).toBe('/org/agents/guide');
    expect(screen.getByRole('link', { name: 't_1234abcd' }).getAttribute('href')).toBe('/board/t_1234abcd');
    expect((await screen.findByRole('link', { name: 'Research/demo.md' })).getAttribute('href')).toBe('/file/Research/demo.md');
    expect(screen.getByRole('link', { name: 'open ticket' }).getAttribute('href')).toBe('/board/t_abcdef12');
  });
  it('keeps literal output and links references without turning unknown words into links', async () => {
    const text = '{"agent":"@guide", "ticket":"t_1234abcd", "file":"Research/demo.md"}\n  unknown';
    setup(text, true);
    const link = await screen.findByRole('link', { name: '@guide' });
    expect(link.parentElement?.textContent).toBe(text);
    expect((await screen.findByRole('link', { name: 'Research/demo.md' })).getAttribute('href')).toBe('/file/Research/demo.md');
    expect(screen.queryByRole('link', { name: 'unknown' })).toBeNull();
  });
  it('links references in code without interpreting tool output as markup', async () => {
    setup('`t_1234abcd`\n\n```json\n{"agent":"@guide"}\n```');
    expect((await screen.findByRole('link', { name: 't_1234abcd' })).closest('code')).toBeTruthy();
    expect((await screen.findByRole('link', { name: '@guide' })).closest('pre')).toBeTruthy();
  });
  it('does not execute HTML or unsafe URLs', async () => {
    setup('<script>alert(1)</script>\n\n[unsafe](javascript:alert(1)) t_1234abcd');
    await screen.findByRole('link', { name: 't_1234abcd' });
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});
