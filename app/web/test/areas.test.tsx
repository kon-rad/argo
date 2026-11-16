import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, useLocation } from 'react-router-dom';
import { AreaIndexResponseSchema, AreaPageSchema, ProjectListResponseSchema, ProjectPageSchema, type AreaPage, type ProjectRow } from '@secondbrain/contracts/projects';
import { FEATURE_ROUTES } from '../src/features.js';
import { dueMatches } from '../src/routes/areas/ProjectList.js';
import { eventText } from '../src/routes/areas/parts.js';

/** The /areas pages and /projects across areas, against the API shapes of the shared contracts. All data is made up. */

const row = (slug: string, over: Partial<ProjectRow> = {}): ProjectRow => ({
  area: 'journal', slug, title: slug, outcome: null, next_action: null, stage: 'building', owner: null, due: null, needs_owner: null, notes_path: null,
  archived_at: null, updated_at: '2026-11-10T00:00:00Z', ...over,
});

const INDEX = AreaIndexResponseSchema.parse({
  areas: [
    { slug: 'journal', title: 'Journal', status: 'active', division: 'product', division_name: 'Product', team: 'apps', team_name: 'Apps', owner: 'ada', health: 'green', needs_owner: null,
      description: 'A private journal', archived_at: null, updated_at: '2026-11-10T00:00:00Z', active_projects: 3, kpis: { total: 3, with_target: 2, on_target: 1 } },
    { slug: 'studio', title: 'Studio', status: 'active', division: 'media', division_name: 'Media', team: null, team_name: null, owner: null, health: null, needs_owner: 'Pick a camera',
      description: null, archived_at: null, updated_at: '2026-11-10T00:00:00Z', active_projects: 1, kpis: null },
    { slug: 'garden', title: 'Garden', status: 'parked', division: 'media', division_name: 'Media', team: null, team_name: null, owner: null, health: null, needs_owner: null,
      description: null, archived_at: null, updated_at: '2026-11-10T00:00:00Z', active_projects: 0, kpis: null },
    { slug: 'old-shop', title: 'Old shop', status: 'active', division: null, division_name: null, team: null, team_name: null, owner: null, health: null, needs_owner: null,
      description: null, archived_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', active_projects: 0, kpis: null },
  ],
});

/** An area with everything: links, a style guide, asset images, goals, KPIs with readings, a roadmap, history. */
const JOURNAL: AreaPage = AreaPageSchema.parse({
  area: { slug: 'journal', title: 'Journal', status: 'active', division: 'product', division_name: 'Product', team: 'apps', team_name: 'Apps', owner: 'ada', members: ['ada', 'lin'],
    health: 'green', needs_owner: null, home_path: 'Areas/journal', archived_at: null, updated_at: '2026-11-10T00:00:00Z' },
  home: { path: 'Areas/journal/README.md', description: 'A private journal', excerpt: 'The journal is where the day gets written down.' },
  links: [
    { group: 'websites', items: [{ text: 'journal.example.com', href: 'https://journal.example.com', path: null }] },
    { group: 'socials', items: [{ text: 'Areas/journal/social-channels.md', href: null, path: 'Areas/journal/social-channels.md' }] },
  ],
  style: {
    guide: { path: 'Areas/journal/brand/style-guide.md', markdown: '# Style guide\n\nUse the serif for headings.', truncated: false },
    assets: { path: 'Areas/journal/brand/assets/', images: [{ path: 'Areas/journal/brand/assets/logo.png', name: 'logo.png' }, { path: 'Areas/journal/brand/assets/mark.svg', name: 'mark.svg' }], more: 0 },
    other: [],
  },
  goals: [{ code: null, text: 'Reach 100 paying users' }, { code: 'Q1', text: 'Ship the sync' }],
  kpis: [
    { key: 'paying-users', name: 'Paying users', unit: 'users', target: 100, by: '2027-03-31', direction: 'up', latest: { value: 120, at: '2026-11-10T00:00:00Z' }, on_target: true,
      readings: [{ value: 40, at: '2026-11-01T00:00:00Z' }, { value: 120, at: '2026-11-10T00:00:00Z' }] },
    { key: 'posts', name: 'Posts', unit: null, target: null, by: null, direction: 'up', latest: null, on_target: null, readings: [] },
  ],
  roadmap: [
    row('export', { title: 'Export', stage: 'idea', due: '2020-01-01' }),
    row('sync', { title: 'Sync', outcome: 'Two devices show the same entries', next_action: 'write the merge test', due: '2099-12-20', owner: 'lin' }),
  ],
  recent: [
    { id: 3, at: '2026-11-10T00:00:00Z', actor: 'ada', source: 'kpi', kind: 'kpi_reading', field: 'paying-users', from: 40, to: 120, note: null, project: null, project_title: null },
    { id: 2, at: '2026-11-09T00:00:00Z', actor: 'lin', source: 'cli', kind: 'stage', field: 'stage', from: 'designing', to: 'building', note: 'design agreed', project: 'sync', project_title: 'Sync' },
  ],
});

/** An area with none of the optional sections: no home note, no links, no style, no goals, no KPIs, nothing open. */
const STUDIO: AreaPage = AreaPageSchema.parse({
  area: { slug: 'studio', title: 'Studio', status: 'active', division: 'media', division_name: 'Media', team: null, team_name: null, owner: null, members: [],
    health: null, needs_owner: null, home_path: null, archived_at: null, updated_at: '2026-11-10T00:00:00Z' },
  home: null, links: [], style: null, goals: [], kpis: [], roadmap: [], recent: [],
});

const LIST = ProjectListResponseSchema.parse({
  projects: [
    row('sync', { title: 'Sync', outcome: 'Two devices show the same entries', due: '2099-12-20' }),
    row('export', { title: 'Export', stage: 'idea', due: '2020-01-01' }),
    row('reel', { area: 'studio', title: 'Weekly reel', stage: 'testing' }),
    row('launch', { area: 'studio', title: 'Launch film', stage: 'live', due: '2020-02-01' }),
  ],
});

const DETAIL = ProjectPageSchema.parse({
  project: { ...row('sync', { title: 'Sync', outcome: 'Two devices show the same entries', next_action: 'write the merge test', due: '2099-12-20', owner: 'lin', stage: 'testing' }),
    area_title: 'Journal', health: null, blocked_on: null, started: null, shipped_at: null, area_archived: false },
  stages: [{ from: 'building', to: 'testing', at: '2026-11-09T00:00:00Z', by: 'lin', note: 'merge works' }, { from: null, to: 'building', at: '2026-11-01T00:00:00Z', by: 'ada', note: 'added' }],
  verifications: [{ kind: 'test', check: 'npm test', result: 'pass', evidence: '12 passed', at: '2026-11-09T00:00:00Z', by: 'lin' }],
  readme: { path: 'Areas/journal/projects/sync/README.md', excerpt: 'Entries merge by timestamp.' },
});

let path = '';
function Probe() {
  const l = useLocation();
  path = l.pathname + l.search;
  return null;
}

interface Call { url: URL; init?: RequestInit }

function mount(at: string, patch?: (call: Call) => Response | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: new URL(String(input), 'http://x'), init };
      calls.push(call);
      const custom = patch?.(call);
      if (custom) return custom;
      const p = call.url.pathname;
      if (p === '/api/areas' && call.url.searchParams.get('view') === 'index') return Response.json(INDEX);
      if (p === '/api/areas/journal') return Response.json(JOURNAL);
      if (p === '/api/areas/studio') return Response.json(STUDIO);
      if (p === '/api/projects') return Response.json(LIST);
      if (p === '/api/projects/journal/sync') return Response.json(DETAIL);
      if (p.startsWith('/api/areas/') || p.startsWith('/api/projects/')) return Response.json({ error: { message: 'not found' } }, { status: 404 });
      return Response.json({});
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[at]}>
        <Probe />
        <Routes>{FEATURE_ROUTES.projects}</Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('/areas', () => {
  it('groups the active areas by division with project count, owner and KPI health when the area has KPIs', async () => {
    mount('/areas');
    const product = await screen.findByRole('region', { name: 'Product' });
    const journal = within(product).getByText('Journal').closest('li')!;
    expect(journal.textContent).toContain('3 active projects');
    expect(journal.textContent).toContain('owner ada');
    expect(journal.textContent).toContain('KPIs: 1 of 2 at target');
    expect(journal.textContent).toContain('A private journal');
    expect(within(product).getByRole('link', { name: 'Journal' }).getAttribute('href')).toBe('/areas/journal');
    // An area with no KPIs says nothing about them.
    const studio = within(screen.getByRole('region', { name: 'Media' })).getByText('Studio').closest('li')!;
    expect(studio.textContent).toContain('1 active project');
    expect(studio.textContent).not.toMatch(/KPI/);
    expect(studio.textContent).toContain('Needs you: Pick a camera');
  });

  it('keeps parked and archived areas behind their own toggles', async () => {
    mount('/areas');
    await screen.findByText('Journal');
    expect(screen.queryByText('Garden')).toBeNull();
    expect(screen.queryByText('Old shop')).toBeNull();
    fireEvent.click(screen.getByLabelText('Parked (1)'));
    expect(screen.getByText('Garden')).toBeTruthy();
    expect(screen.queryByText('Old shop')).toBeNull();
    fireEvent.click(screen.getByLabelText('Archived (1)'));
    const none = screen.getByRole('region', { name: 'No division' });
    expect(within(none).getByText('Old shop')).toBeTruthy();
    expect(within(none).getByText('Archived')).toBeTruthy();
  });
});

describe('/areas/<slug>', () => {
  it('an area with KPIs and assets shows the header, links, style guide, images, goals, KPI trend, roadmap and history', async () => {
    mount('/areas/journal');
    expect(await screen.findByRole('heading', { level: 1, name: 'Journal' })).toBeTruthy();
    expect(screen.getByText('A private journal')).toBeTruthy();
    expect(screen.getByText('Owner: ada')).toBeTruthy();
    expect(screen.getByText('Team: Apps (ada, lin)')).toBeTruthy();

    // Links as given: a URL opens outside, a vault path opens the note.
    const links = screen.getByRole('region', { name: 'Links' });
    expect(within(links).getByRole('link', { name: 'journal.example.com' }).getAttribute('href')).toBe('https://journal.example.com');
    expect(within(links).getByRole('link', { name: 'Areas/journal/social-channels.md' }).getAttribute('href')).toBe('/file/Areas/journal/social-channels.md');

    // The style guide is rendered as markdown, the images of the asset folder inline.
    const style = screen.getByRole('region', { name: 'Style and assets' });
    expect(within(style).getByRole('heading', { name: 'Style guide' })).toBeTruthy();
    expect(within(style).getByText('Use the serif for headings.')).toBeTruthy();
    const images = within(within(style).getByRole('list', { name: 'Asset images' })).getAllByRole('img') as HTMLImageElement[];
    expect(images.map((i) => [i.alt, new URL(i.src, 'http://x').searchParams.get('path')])).toEqual([
      ['logo.png', 'Areas/journal/brand/assets/logo.png'],
      ['mark.svg', 'Areas/journal/brand/assets/mark.svg'],
    ]);

    expect(within(screen.getByRole('region', { name: 'Goals' })).getAllByRole('listitem').map((l) => l.textContent)).toEqual(['Reach 100 paying users', 'Q1 Ship the sync']);

    // KPIs: the latest value, the target, and a small trend once there are two readings.
    const kpis = screen.getByRole('region', { name: 'KPIs' });
    const users = within(kpis).getByRole('listitem', { name: 'Paying users' });
    expect(users.textContent).toContain('120');
    expect(users.textContent).toContain('target 100 users by 2027-03-31');
    expect(users.textContent).toContain('at target');
    expect(within(users).getByRole('img', { name: 'Paying users: 40 to 120 over 2 readings' })).toBeTruthy();
    const posts = within(kpis).getByRole('listitem', { name: 'Posts' });
    expect(posts.textContent).toContain('no reading');
    expect(within(posts).queryByRole('img')).toBeNull();

    // The roadmap is the open projects by due date, each linking to its page.
    const roadmap = screen.getByRole('region', { name: 'Roadmap' });
    expect(within(roadmap).getAllByRole('listitem').map((l) => l.querySelector('a')!.textContent)).toEqual(['Export', 'Sync']);
    expect(within(roadmap).getByRole('link', { name: 'Sync' }).getAttribute('href')).toBe('/projects/journal/sync');
    expect(roadmap.textContent).toContain('due 2020-01-01 (overdue)');
    expect(roadmap.textContent).toContain('Next: write the merge test');

    const recent = screen.getByRole('region', { name: 'Recent activity' });
    expect(recent.textContent).toContain('Journal paying-users: 40 → 120');
    expect(recent.textContent).toContain('Sync stage designing → building · lin · design agreed');
  });

  it('an area with neither KPIs nor assets draws none of those sections', async () => {
    mount('/areas/studio');
    expect(await screen.findByRole('heading', { level: 1, name: 'Studio' })).toBeTruthy();
    for (const name of ['KPIs', 'Style and assets', 'Links', 'Goals', 'About']) expect(screen.queryByRole('region', { name })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(/This area has no home note yet/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Roadmap' })).getByText(/No open projects/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Recent activity' })).getByText('Nothing changed in the last 14 days.')).toBeTruthy();
  });

  it('says so when there is no such area', async () => {
    mount('/areas/nope');
    expect(await screen.findByText(/No area “nope”/)).toBeTruthy();
  });

  it('the Archive button asks for a note before it archives, and sends the note', async () => {
    const calls = mount('/areas/journal', ({ url, init }) => (init?.method === 'POST' && url.pathname === '/api/areas/journal/archive' ? Response.json({ archived: true, changed: true }) : undefined));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = screen.getByRole('dialog', { name: 'Archive Journal' });
    const submit = within(dialog).getByRole('button', { name: 'Archive' }) as HTMLButtonElement;
    // No note, no archive.
    expect(submit.disabled).toBe(true);
    fireEvent.submit(dialog);
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
    fireEvent.change(within(dialog).getByLabelText('Note: why is it being archived?'), { target: { value: '  folded into the studio  ' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(post.url.pathname).toBe('/api/areas/journal/archive');
    expect(JSON.parse(String(post.init!.body))).toEqual({ note: 'folded into the studio' });
    // The page reads the area again after the write.
    await waitFor(() => expect(calls.filter((c) => c.url.pathname === '/api/areas/journal' && !c.init?.method).length).toBeGreaterThan(1));
  });

  it('the archive dialog closes on Cancel without writing, and shows a refusal', async () => {
    const calls = mount('/areas/journal', ({ init }) => (init?.method === 'POST' ? Response.json({ error: { message: 'no area "journal"' } }, { status: 404 }) : undefined));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'done' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('no area "journal"');
  });

  it('an archived area offers Unarchive, which needs no note', async () => {
    const calls = mount('/areas/journal', ({ url, init }) => {
      if (init?.method === 'POST') return Response.json({ archived: false, changed: true });
      if (url.pathname === '/api/areas/journal') return Response.json({ ...JOURNAL, area: { ...JOURNAL.area, archived_at: '2026-11-12T00:00:00Z' } });
      return undefined;
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Unarchive' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Unarchive Journal' })).getByRole('button', { name: 'Unarchive' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST' && c.url.pathname === '/api/areas/journal/unarchive')).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.init?.method === 'POST')!.init!.body))).toEqual({});
  });
});

describe('/projects across areas', () => {
  const titles = () => within(screen.getByRole('list', { name: 'Projects' })).getAllByRole('listitem').map((l) => l.querySelector('a')!.textContent);

  it('lists every project by due date and filters by area, stage and due', async () => {
    mount('/projects');
    await screen.findByText('Weekly reel');
    expect(titles()).toEqual(['Export', 'Launch film', 'Sync', 'Weekly reel']);
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: 'studio' } });
    expect(titles()).toEqual(['Launch film', 'Weekly reel']);
    expect(path).toBe('/projects?area=studio');
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'testing' } });
    expect(titles()).toEqual(['Weekly reel']);
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: '' } });
    // Overdue: past its date and not shipped. The live project with an old date is not late.
    fireEvent.change(screen.getByLabelText('Due'), { target: { value: 'overdue' } });
    expect(titles()).toEqual(['Export']);
    fireEvent.change(screen.getByLabelText('Due'), { target: { value: 'none' } });
    expect(titles()).toEqual(['Weekly reel']);
  });

  it('reads the filters from the URL and asks for archived projects only when the filter is on', async () => {
    const calls = mount('/projects?area=journal&stage=building');
    await screen.findByText('Sync');
    expect(titles()).toEqual(['Sync']);
    expect(calls.find((c) => c.url.pathname === '/api/projects')!.url.searchParams.get('archived')).toBeNull();
    fireEvent.click(screen.getByLabelText('Archived'));
    await waitFor(() => expect(calls.some((c) => c.url.pathname === '/api/projects' && c.url.searchParams.get('archived') === '1')).toBe(true));
    expect((await screen.findByRole('link', { name: 'Sync' })).getAttribute('href')).toBe('/projects/journal/sync');
  });

  it('knows which due dates match a filter', () => {
    const today = '2026-11-15';
    expect(dueMatches({ due: '2026-11-14', stage: 'building' }, 'overdue', today)).toBe(true);
    expect(dueMatches({ due: '2026-11-14', stage: 'done' }, 'overdue', today)).toBe(false);
    expect(dueMatches({ due: '2026-11-15', stage: 'building' }, 'overdue', today)).toBe(false);
    expect(dueMatches({ due: '2026-11-22', stage: 'idea' }, 'week', today)).toBe(true);
    expect(dueMatches({ due: '2026-11-23', stage: 'idea' }, 'week', today)).toBe(false);
    expect(dueMatches({ due: '2026-12-15', stage: 'idea' }, 'month', today)).toBe(true);
    expect(dueMatches({ due: null, stage: 'idea' }, 'month', today)).toBe(false);
    expect(dueMatches({ due: null, stage: 'idea' }, 'none', today)).toBe(true);
  });
});

describe('/projects/<area>/<slug>', () => {
  it('shows the outcome, the stage history, the verifications, the next action and the README excerpt', async () => {
    mount('/projects/journal/sync');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sync' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Journal' }).getAttribute('href')).toBe('/areas/journal');
    expect(within(screen.getByRole('region', { name: 'Outcome' })).getByText('Two devices show the same entries')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Next action' })).getByText('write the merge test')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Stage history' })).getAllByRole('listitem').map((l) => l.textContent)).toEqual([
      '2026-11-09 building → testing · lin · merge works',
      '2026-11-01 new → building · ada · added',
    ]);
    const checks = screen.getByRole('region', { name: 'Verifications' });
    expect(checks.textContent).toContain('✓ pass (test) npm test');
    expect(checks.textContent).toContain('12 passed');
    const readme = screen.getByRole('region', { name: 'README' });
    expect(within(readme).getByText('Entries merge by timestamp.')).toBeTruthy();
    expect(within(readme).getByRole('link', { name: 'Areas/journal/projects/sync/README.md' }).getAttribute('href')).toBe('/file/Areas/journal/projects/sync/README.md');
  });

  it('archives the project through its own path, with the note', async () => {
    const calls = mount('/projects/journal/sync', ({ init }) => (init?.method === 'POST' ? Response.json({ archived: true, changed: true }) : undefined));
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = screen.getByRole('dialog', { name: 'Archive Sync' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'superseded' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(post.url.pathname).toBe('/api/projects/journal/sync/archive');
    expect(JSON.parse(String(post.init!.body))).toEqual({ note: 'superseded' });
  });
});

describe('the old /projects/<area-slug> link', () => {
  it('redirects to /areas/<area-slug>', async () => {
    mount('/projects/journal');
    await waitFor(() => expect(path).toBe('/areas/journal'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Journal' })).toBeTruthy();
  });
});

describe('the change history in words', () => {
  const e = (over: object) => ({ id: 1, at: '', actor: 'a', source: 'cli', kind: 'changed', field: null, from: null, to: null, note: null, project: null, project_title: null, ...over });
  it('says what each kind of row means', () => {
    expect(eventText(e({ kind: 'created' }))).toBe('added');
    expect(eventText(e({ kind: 'stage', field: 'stage', from: 'idea', to: 'building' }))).toBe('stage idea → building');
    expect(eventText(e({ kind: 'stage', field: 'status', from: 'active', to: 'parked' }))).toBe('status active → parked');
    expect(eventText(e({ kind: 'changed', field: 'due', from: null, to: '2026-12-31' }))).toBe('due: none → 2026-12-31');
    expect(eventText(e({ kind: 'frontmatter', field: 'kpis', from: [], to: [] }))).toBe('home note: kpis changed');
    expect(eventText(e({ kind: 'kpi_reading', field: 'mrr', to: 12 }))).toBe('mrr: 12');
    expect(eventText(e({ kind: 'archived' }))).toBe('archived');
  });
});
