import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Ventures, { swatches } from '../src/routes/Ventures.js';

const base = { kind: 'product', summary: null, parent: null, division: null, home_path: 'Areas/x', goals: [], links: [], sort: 0, projects: [], children: [], has_readme: true, has_brand: true };
const LIST = {
  kinds: ['product'],
  ventures: [
    { ...base, slug: 'umb', name: 'Umbrella', kind: 'brand', children: ['kid'] },
    { ...base, slug: 'kid', name: 'Child One', parent: 'umb', projects: [{ slug: 'p', title: 'P', stage: 'building', health: null }] },
  ],
};
const DETAIL = {
  ...base, slug: 'umb', name: 'Umbrella', kind: 'brand', has_readme: false,
  brand: { tokens: { venture: 'umb', palette: { ink: '#111111', accent: '#7c5cff' }, fonts: { heading: 'Inter' }, voice: 'plain' }, body: '', file: 'Areas/x/brand/brand.md', assets: { logo: [], fonts: [], images: [] } },
  kpis: [{ key: 'k', label: 'Followers', unit: 'followers', money: false, target: 1000, value: 250, sampled_at: null, placeholder: false }],
};

function mount(path: string, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/ventures" element={<Ventures />} /><Route path="/ventures/:slug" element={<Ventures />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Ventures', () => {
  it('lists parents with their children nested', async () => {
    mount('/ventures', LIST);
    expect(await screen.findByText('Umbrella')).toBeTruthy();
    expect(screen.getByText('Child One')).toBeTruthy();
    expect(screen.getByText('1 projects')).toBeTruthy();
  });

  it('shows brand swatches, KPIs and the scaffold button when the README is missing', async () => {
    mount('/ventures/umb', DETAIL);
    expect(await screen.findByText('palette.accent')).toBeTruthy();
    expect(screen.getByText('#7c5cff')).toBeTruthy();
    expect(screen.getByText(/Inter/)).toBeTruthy();
    expect(screen.getByText('250 followers')).toBeTruthy();
    expect(screen.getByText('Create README and brand folder')).toBeTruthy();
  });

  it('swatches finds hex values at any depth and ignores the rest', () => {
    expect(swatches({ a: '#fff', b: { c: '#112233', d: 'red' }, e: 5 })).toEqual([{ name: 'a', hex: '#fff' }, { name: 'b.c', hex: '#112233' }]);
  });
});
