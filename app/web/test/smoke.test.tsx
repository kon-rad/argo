import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App.js';

const TREE_ROOT = {
  path: '',
  dirs: [{ name: 'Areas', path: 'Areas', child_count: 12 }],
  files: [
    {
      id: 1,
      name: 'CLAUDE.md',
      path: 'CLAUDE.md',
      ext: '.md',
      is_markdown: true,
      size_bytes: 4096,
      mtime: '2026-08-24T00:00:00.000Z',
      title: 'CLAUDE.md — secondbrain vault',
    },
  ],
  total: 1,
  has_more: false,
};

const FILE = {
  file: {
    id: 1,
    name: 'CLAUDE.md',
    path: 'CLAUDE.md',
    parent_path: '',
    ext: '.md',
    is_markdown: true,
    size_bytes: 4096,
    mtime: '2026-08-24T00:00:00.000Z',
    title: 'House rules',
    body: 'See [[PARA Guide]] and [[Missing Note]].\n\n`[[Not A Link]]`\n',
  },
  frontmatter: { title: 'House rules' },
  tags: ['vault'],
  links: [
    {
      target_raw: 'PARA Guide',
      alias: null,
      file_id: 2,
      path: 'PARA Guide.md',
      title: 'PARA Guide',
    },
    { target_raw: 'Missing Note', alias: null, file_id: null, path: null, title: null },
  ],
  backlinks: [{ id: 3, path: 'Projects/plan.md', title: 'Plan' }],
};

let META: Record<string, unknown> = { modules: [], owner: 'owner', devLogPath: null, docsPath: null, robot: false };

function stubFetch(auth = { required: false, authenticated: true }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith('/api/auth/me')
        ? auth
        : url.startsWith('/api/meta')
        ? META
        : url.startsWith('/api/tree')
        ? TREE_ROOT
        : url.startsWith('/api/file')
          ? FILE
          : url.startsWith('/api/system')
            ? { vault_root: '/vault', counts: { files: 1, markdown: 1, links: 2, tags: 1 } }
            : url.startsWith('/api/sources')
              ? { sources: [] }
              : url.startsWith('/api/runs')
                ? { runs: [] }
                : url.startsWith('/api/voice/settings')
                  ? {
                      settings: { autoSpeak: false, voice: 'af_heart', minTaskSeconds: 120 },
                      server: { url: 'http://127.0.0.1:8880', model: 'kokoro', up: true },
                    }
                  : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

function renderAt(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  META = { modules: [], owner: 'owner', devLogPath: null, docsPath: null, robot: false };
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('nav follows /api/meta', () => {
  it('hides optional pages and note links when nothing is enabled', async () => {
    renderAt('/');
    await screen.findByLabelText('Search the vault');
    fireEvent.click(await screen.findByRole('button', { name: /Vault/ }));
    expect(screen.getByRole('menuitem', { name: 'Browse' })).toBeDefined();
    // Menus with no enabled page are left out entirely.
    for (const menu of [/Work/, /Life/, /Docs/]) expect(screen.queryByRole('button', { name: menu })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Brain map' })).toBeNull();
  });

  it('shows enabled modules and configured note links', async () => {
    META = { modules: ['ring', 'agents'], owner: 'owner', devLogPath: 'Projects/dev-log.md', docsPath: null, robot: false };
    renderAt('/');
    fireEvent.click(await screen.findByRole('button', { name: /Life/ }));
    expect(screen.getByRole('menuitem', { name: 'Ring' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Work/ }));
    expect(screen.getByRole('menuitem', { name: 'Agents' })).toBeDefined();
    expect(screen.getByRole('menuitem', { name: 'Cron' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: 'Usage' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Docs/ }));
    expect(screen.getByRole('menuitem', { name: 'Devlog' }).getAttribute('href')).toBe('/file/Projects/dev-log.md');
    expect(screen.queryByRole('menuitem', { name: 'Docs' })).toBeNull();
  });

  it('with the chat module on, the header button and the Vault menu entry open the chat panel', async () => {
    META = { modules: ['chat'], owner: 'owner', devLogPath: null, docsPath: null, robot: false };
    renderAt('/');
    const button = await screen.findByRole('button', { name: 'Ask your second brain' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: /Vault/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ask your second brain' }));
    expect(await screen.findByRole('dialog', { name: 'Ask your second brain' })).toBeDefined();
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('without the chat module, neither the button nor the menu entry exists', async () => {
    renderAt('/');
    await screen.findByLabelText('Search the vault');
    expect(screen.queryByRole('button', { name: 'Ask your second brain' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Vault/ }));
    expect(screen.queryByRole('menuitem', { name: 'Ask your second brain' })).toBeNull();
  });
});

describe('App', () => {
  it('renders the search box and the tree', async () => {
    renderAt('/');
    expect(await screen.findByLabelText('Search the vault')).toBeDefined();
    expect(screen.getByTestId('tree')).toBeDefined();
    await waitFor(() => expect(screen.getByText('Areas')).toBeDefined());
    expect(screen.getByText('CLAUDE.md')).toBeDefined();
  });

  it('does not fetch a directory until it is expanded', async () => {
    renderAt('/');
    await waitFor(() => expect(screen.getByText('Areas')).toBeDefined());
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('path=Areas'))).toBe(false);
  });

  it('renders a note, resolving wikilinks and dimming the dead one', async () => {
    renderAt('/file/CLAUDE.md');
    // "House rules" is both the heading and a frontmatter value, so anchor on
    // the heading rather than the text.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'House rules' })).toBeDefined(),
    );

    const resolved = screen.getByText('PARA Guide') as HTMLAnchorElement;
    expect(resolved.tagName).toBe('A');
    expect(resolved.getAttribute('href')).toBe('/file/PARA%20Guide.md');

    const dead = screen.getByText('Missing Note');
    expect(dead.tagName).toBe('SPAN');
    expect(dead.className).toContain('wikilink-dead');

    // Inside inline code it must stay text, not become either kind of link.
    expect(screen.getByText('[[Not A Link]]').tagName).toBe('CODE');

    expect(screen.getByText('Plan')).toBeDefined();
  });

  it('shows the empty state before a file is chosen', async () => {
    renderAt('/');
    expect(await screen.findByText(/Pick a note from the tree/)).toBeDefined();
  });

  it('offers Download and Edit on a note', async () => {
    META = { modules: ['voice'], owner: 'owner', devLogPath: null, docsPath: null, robot: false };
    renderAt('/file/CLAUDE.md');
    const download = (await screen.findByText('Download')) as HTMLAnchorElement;
    expect(download.getAttribute('href')).toBe('/api/raw?path=CLAUDE.md&download=1');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDefined();
    // The voice module is on and its server answers, so the note can be read aloud and the switch shows.
    expect(await screen.findByRole('button', { name: 'Listen' })).toBeDefined();
    expect(screen.getByRole('switch')).toBeDefined();
  });

  it('shows only the login screen when the server requires a session', async () => {
    stubFetch({ required: true, authenticated: false });
    renderAt('/file/CLAUDE.md');
    expect(await screen.findByLabelText('Authenticator code')).toBeDefined();
    expect(screen.queryByLabelText('Search the vault')).toBeNull();
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls.every((u) => u.startsWith('/api/auth/'))).toBe(true);
  });

  it('enters the app after a successful login, and back to the login screen on log out', async () => {
    // A stateful fake server: /auth/me reflects the session the login creates.
    const auth = { required: true, authenticated: false };
    stubFetch(auth);
    const base = fetch as unknown as ReturnType<typeof vi.fn>;
    const inner = base.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    base.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/auth/login') || url.startsWith('/api/auth/logout')) {
        auth.authenticated = url.startsWith('/api/auth/login');
        return new Response(JSON.stringify({ authenticated: auth.authenticated }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return inner(input, init);
    });
    renderAt('/');
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } });
    fireEvent.submit(screen.getByLabelText('Authenticator code').closest('form')!);
    // Regression 2026-10-11: the login succeeded but the page stayed on the form.
    expect(await screen.findByLabelText('Search the vault')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(await screen.findByLabelText('Authenticator code')).toBeDefined();
  });

  it('shows Log out instead of the robot button on the server', async () => {
    stubFetch({ required: true, authenticated: true });
    renderAt('/');
    expect(await screen.findByRole('button', { name: 'Log out' })).toBeDefined();
  });

  it('refetches the tree when the refresh button rescans the vault', async () => {
    // A stateful fake server: the scan "finds" a new folder on disk.
    let scanned = false;
    let runId = 1;
    const vaultSource = () => ({
      id: 1,
      kind: 'vault',
      name: 'Vault',
      running: false,
      last_run: { id: runId, status: 'ok', finished_at: '2026-09-28T00:00:00.000Z' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        let body: unknown = {};
        if (url.startsWith('/api/auth/me')) body = { required: false, authenticated: true };
        else if (url.startsWith('/api/sources/1/sync')) {
          scanned = true;
          runId = 2;
          body = { run_id: 2, status: 'queued' };
        } else if (url.startsWith('/api/sources')) body = { sources: [vaultSource()] };
        else if (url.startsWith('/api/tree'))
          body = scanned
            ? { ...TREE_ROOT, dirs: [...TREE_ROOT.dirs, { name: 'Fresh', path: 'Fresh', child_count: 1 }] }
            : TREE_ROOT;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    renderAt('/');
    await waitFor(() => expect(screen.getByText('Areas')).toBeDefined());
    expect(screen.queryByText('Fresh')).toBeNull();

    (await screen.findByRole('button', { name: 'Refresh file tree' })).click();
    expect(await screen.findByText('Fresh')).toBeDefined();
  });
});
