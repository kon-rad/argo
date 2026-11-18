import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Skills from '../src/routes/skills/Skills.js';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

const policy = { file: '.agents/skills-policy.yaml', exists: false, valid: true, errors: [], warnings: [], digest: null, revision: null, dirty: null };
const candidate = {
  id: 'private:report', name: 'report', source: 'private', root: '.agents/skills', relPath: 'report', category: null, description: 'Writes the weekly report.',
  valid: true, errors: [], warnings: [], digest: `sha256:${'a'.repeat(64)}`, files: 2, bytes: 120, revision: 'b'.repeat(40), dirty: false, tracked: true,
  linkOf: null, effective: true, shadowedBy: null, metadata: { version: null, owner: null, license: null, depends: [], requires: { bins: [], env: [] } },
};
const row = (name: string, over: Record<string, unknown> = {}) => ({
  name, effective: { ...candidate, id: `private:${name}`, name }, candidates: [{ ...candidate, id: `private:${name}`, name }],
  flags: { override: false, duplicate: false, invalid: false, dirty: false }, lifecycle: { status: 'active', replacement: null, note: null },
  assigned: 0, denied: 0, references: 0, ...over,
});

function stub(handler: (url: string) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => handler(String(input))));
}

function renderAt(view: Parameters<typeof Skills>[0]['view'], path = '/skills') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Skills view={view} /></MemoryRouter></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Skills library', () => {
  it('shows the empty state and the legacy banner for an empty catalog', async () => {
    stub(() => json({ mode: 'legacy', policy, roots: [], skills: [], generatedAt: '2026-01-01T00:00:00Z' }));
    renderAt('library');
    expect(await screen.findByText(/No skills found/)).toBeTruthy();
    expect(screen.getByText(/every agent sees its runtime's whole skill folder/i)).toBeTruthy();
  });

  it('shows the server error with a retry', async () => {
    let calls = 0;
    stub(() => { calls++; return json({ error: { message: 'policy file unreadable' } }, 500); });
    renderAt('library');
    expect((await screen.findByRole('alert')).textContent).toMatch(/policy file unreadable/);
    fireEvent.click(screen.getByText('Try again'));
    await screen.findByRole('alert');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('filters by search and flag, and shows overrides', async () => {
    stub(() => json({ mode: 'managed', policy: { ...policy, exists: true }, roots: [], generatedAt: '2026-01-01T00:00:00Z',
      skills: [row('report', { flags: { override: true, duplicate: false, invalid: false, dirty: false } }), row('ingest')] }));
    renderAt('library');
    expect((await screen.findAllByText('report')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('override').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'ingest' } });
    expect(screen.queryAllByText('report')).toHaveLength(0);
    expect(screen.getAllByText('ingest').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Flag'), { target: { value: 'override' } });
    expect(screen.queryAllByText('ingest')).toHaveLength(0);
  });
});

describe('Skills machines', () => {
  it('says a machine is unknown until it acknowledges', async () => {
    stub(() => json({ staleAfterHours: 24, mode: 'managed', notes: [], hosts: [] }));
    renderAt('machines', '/skills/machines');
    expect(await screen.findByText(/No machines yet/)).toBeTruthy();
    expect(screen.getByText(/Pushing to Git is not a sync/)).toBeTruthy();
  });
});
