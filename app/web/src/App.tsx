import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Browse from './routes/Browse.js';
import Search from './routes/Search.js';
import VectorSearch from './routes/VectorSearch.js';
import Database from './routes/Database.js';
import Sources from './routes/Sources.js';
import Ring from './routes/Ring.js';
import Agents from './routes/agents/Agents.js';
import Cron from './routes/Cron.js';
import Login from './routes/Login.js';
import { api, AUTH_EXPIRED_EVENT } from './lib/api.js';
import SearchBox from './components/SearchBox.js';
import IndexStatus from './components/IndexStatus.js';
import FriendlyButton from './components/FriendlyButton.js';
import AgentToggle from './components/AgentToggle.js';

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
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
          <NavLink to="/" className={navClass} end>
            Browse
          </NavLink>
          <NavLink to="/vector-search" className={navClass}>
            Vector Search
          </NavLink>
          <NavLink to="/database" className={navClass}>
            Database
          </NavLink>
          {modules.has('agents') && (
            <>
              <NavLink to="/agents" className={navClass}>
                Agents
              </NavLink>
              <NavLink to="/cron" className={navClass}>
                Cron
              </NavLink>
            </>
          )}
          {modules.has('ring') && (
            <NavLink to="/ring" className={navClass}>
              Ring
            </NavLink>
          )}
          <NavLink to="/sources" className={navClass}>
            Sources
          </NavLink>
          {meta.data?.devLogPath && (
            <NavLink to={`/file/${meta.data.devLogPath}`} className={navClass}>
              Devlog
            </NavLink>
          )}
          {meta.data?.docsPath && (
            <NavLink to={`/file/${meta.data.docsPath}`} className={navClass}>
              Docs
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

        {modules.has('agents') && (
          <div className="shrink-0 border-l border-[var(--rule)] pl-3">
            <AgentToggle />
          </div>
        )}

        <div className="shrink-0 border-l border-[var(--rule)] pl-3 text-xs">
          <IndexStatus />
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
          <Route path="/ring" element={<Ring />} />
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
