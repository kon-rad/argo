import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Browse from './routes/Browse.js';
import Search from './routes/Search.js';
import VectorSearch from './routes/VectorSearch.js';
import Database from './routes/Database.js';
import Sources from './routes/Sources.js';
import Ring from './routes/Ring.js';
import Agents from './routes/agents/Agents.js';
import Usage from './routes/usage/Usage.js';
import UsageSession from './routes/usage/UsageSession.js';
import Cron from './routes/Cron.js';
import NavMenu, { type NavItem } from './components/NavMenu.js';
import Projects from './routes/Projects.js';
import Tv from './routes/Tv.js';
import Media from './routes/Media.js';
import Fund from './routes/Fund.js';
// three.js is large: the map loads only when it's opened.
const MapPage = lazy(() => import('./routes/Map.js'));
import Org from './routes/org/Org.js';
import Login from './routes/Login.js';
import { api, AUTH_EXPIRED_EVENT, type AppMeta } from './lib/api.js';
import SearchBox from './components/SearchBox.js';
import IndexStatus from './components/IndexStatus.js';
import UsageChip from './components/UsageChip.js';
import FriendlyButton from './components/FriendlyButton.js';
import AgentToggle from './components/AgentToggle.js';
import VoiceToggle from './components/VoiceToggle.js';
import ShortcutsHelp from './components/ShortcutsHelp.js';
import { available, HELP_CODE, isChord, isKey, target } from './lib/shortcuts.js';

const navClass = ({ isActive }: { isActive: boolean }): string =>
  `px-2 py-1 rounded ${isActive ? 'text-[var(--ink)] bg-[var(--paper-sunk)]' : 'text-[var(--ink-dim)] hover:text-[var(--ink)]'}`;

export default function App() {
  const queryClient = useQueryClient();
  const auth = useQuery({ queryKey: ['auth'], queryFn: api.me, staleTime: Infinity, retry: false });

  // Any 401 mid-session (expired, or logged out on another device) drops back
  // to the login screen instead of leaving a page of error messages.
  useEffect(() => {
    const expired = (): void => {
      queryClient.setQueryData(['auth'], { required: true, authenticated: false });
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
  }, [queryClient]);

  if (auth.isPending) return null;
  if (auth.data && !auth.data.authenticated) {
    return (
      <Login
        onSuccess={() => {
          // Nothing fetched while logged out is worth keeping. Drop everything
          // but the auth query, then flip it: clear() would also remove the
          // query this component observes, and invalidating a removed query
          // refetches nothing, which left the page on the login form.
          queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
          queryClient.setQueryData(['auth'], { required: true, authenticated: true });
          void queryClient.invalidateQueries({ queryKey: ['auth'] });
        }}
      />
    );
  }
  return <Shell loginRequired={auth.data?.required ?? false} />;
}

function Shell({ loginRequired }: { loginRequired: boolean }) {
  const queryClient = useQueryClient();
  // Which optional pages and note links this install has; nothing until it answers.
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const modules = new Set(meta.data?.modules ?? []);
  const moduleKey = (meta.data?.modules ?? []).join(',');
  const shortcuts = useMemo(() => available(new Set(moduleKey.split(','))), [moduleKey]);
  const [helpOpen, setHelpOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  async function logout(): Promise<void> {
    await api.logout().catch(() => {});
    // Same rule as login: keep the auth query alive so App sees the change.
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
    queryClient.setQueryData(['auth'], { required: true, authenticated: false });
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (event.repeat || !isChord(event)) return;
      if (isKey(event, HELP_CODE)) {
        event.preventDefault();
        setHelpOpen((o) => !o);
        return;
      }
      const to = target(event, shortcuts);
      if (to) {
        event.preventDefault();
        setHelpOpen(false);
        navigate(to);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, shortcuts]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--rule)] px-3 py-2">
        <Link to="/" className="font-semibold tracking-tight whitespace-nowrap">
          Second Brain
        </Link>

        <SearchBox
          inputRef={searchRef}
          onSubmit={(q) => navigate(`/search?q=${encodeURIComponent(q)}`)}
        />

        <nav className="flex items-center gap-1">
          {/* Menus list only the pages this install has; an empty menu is not shown. */}
          {menus(modules, meta.data).map(([label, items]) => (
            <NavMenu key={label} label={label} items={items} />
          ))}
          {modules.has('tv') && (
            <NavLink to="/tv" className={navClass}>
              TV
            </NavLink>
          )}
          {/* Only where a launch script is configured; the server never mounts the route. */}
          {!loginRequired && meta.data?.robot && <FriendlyButton />}
          {loginRequired && (
            <button type="button" onClick={() => void logout()} className={navClass({ isActive: false })}>
              Log out
            </button>
          )}
        </nav>

        {modules.has('usage') && (
          <div className="shrink-0 border-l border-[var(--rule)] pl-3">
            <UsageChip />
          </div>
        )}

        {modules.has('agents') && (
          <div className="shrink-0 border-l border-[var(--rule)] pl-3">
            <AgentToggle />
          </div>
        )}

        {/* This machine's voice: the Claude Code spoken-alert switch. Never on a server. */}
        {!loginRequired && modules.has('voice') && (
          <div className="shrink-0 border-l border-[var(--rule)] pl-3">
            <VoiceToggle />
          </div>
        )}

        <div className="shrink-0 border-l border-[var(--rule)] pl-3 text-xs">
          <IndexStatus />
        </div>

        <div className="ml-auto shrink-0">
          <ShortcutsHelp shortcuts={shortcuts} open={helpOpen} onOpenChange={setHelpOpen} build={meta.data} />
        </div>
      </header>

      <main className="min-h-0 flex-1">
        <Routes>
          <Route path="/" element={<Browse />} />
          <Route path="/file/*" element={<Browse />} />
          <Route path="/search" element={<Search />} />
          <Route path="/vector-search" element={<VectorSearch />} />
          <Route path="/database" element={<Database />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/agents/*" element={<Agents />} />
          <Route path="/cron" element={<Cron />} />
          <Route path="/cron/:profile/:jobId" element={<Cron />} />
          {modules.has('usage') && <Route path="/usage" element={<Usage />} />}
          {modules.has('usage') && <Route path="/usage/session/:host/:externalId" element={<UsageSession />} />}
          <Route path="/ring" element={<Ring />} />
          {modules.has('projects') && <Route path="/projects" element={<Projects />} />}
          {modules.has('org') && <Route path="/org/*" element={<Org />} />}
          {modules.has('tv') && <Route path="/tv" element={<Tv />} />}
          {modules.has('media') && <Route path="/media" element={<Media />} />}
          {modules.has('fund') && <Route path="/fund" element={<Fund />} />}
          {/* The page was /argo-tv before the engine port; old kiosk URLs land on /tv. */}
          {modules.has('tv') && <Route path="/argo-tv" element={<Navigate to={`/tv${location.search}`} replace />} />}
          {modules.has('map') && (
            <Route path="/map" element={<Suspense fallback={null}><MapPage /></Suspense>} />
          )}
          <Route
            path="*"
            element={
              <div className="p-6 text-[var(--ink-dim)]">
                No such page: <code>{location.pathname}</code>
              </div>
            }
          />
        </Routes>
      </main>
    </div>
  );
}

/** The header menus for this install: core pages plus whichever modules are on. */
function menus(modules: Set<string>, meta: AppMeta | undefined): [string, NavItem[]][] {
  const on = (m: string, item: NavItem): NavItem[] => (modules.has(m) ? [item] : []);
  const vault: NavItem[] = [
    { to: '/', label: 'Browse', end: true },
    ...on('map', { to: '/map', label: 'Brain map' }),
    ...on('media', { to: '/media', label: 'Media' }),
    { to: '/vector-search', label: 'Vector Search' },
    { to: '/database', label: 'Database' },
    { to: '/sources', label: 'Sources' },
  ];
  const work: NavItem[] = [
    ...on('projects', { to: '/projects', label: 'Projects' }),
    ...on('org', { to: '/org', label: 'Org' }),
    ...on('fund', { to: '/fund', label: 'Fund' }),
    ...on('agents', { to: '/agents', label: 'Agents' }),
    ...on('usage', { to: '/usage', label: 'Usage' }),
    ...on('agents', { to: '/cron', label: 'Cron' }),
  ];
  const life: NavItem[] = on('ring', { to: '/ring', label: 'Ring' });
  const docs: NavItem[] = [
    ...(meta?.devLogPath ? [{ to: `/file/${meta.devLogPath}`, label: 'Devlog' }] : []),
    ...(meta?.docsPath ? [{ to: `/file/${meta.docsPath}`, label: 'Docs' }] : []),
  ];
  return ([['Vault', vault], ['Work', work], ['Life', life], ['Docs', docs]] as [string, NavItem[]][]).filter(
    ([, items]) => items.length > 0,
  );
}
