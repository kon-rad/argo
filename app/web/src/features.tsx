import type { ReactElement } from 'react';
import { Route } from 'react-router-dom';
import BoardPage from './routes/board/Board.js';
import Memory from './routes/Memory.js';
import Org from './routes/org/Org.js';
import Projects from './routes/Projects.js';
import LiveAgents from './routes/usage/LiveAgents.js';
import Usage from './routes/usage/Usage.js';
import UsageSession from './routes/usage/UsageSession.js';

/**
 * The page routes of each core feature, by module name. The server's manifest
 * (server/src/features/<name>/manifest.ts) owns the nav link and the API; this map
 * is the web half: which components answer the paths the manifest links to. App.tsx
 * renders the entries of the modules /api/meta says are on.
 */
export const FEATURE_ROUTES: Record<string, ReactElement[]> = {
  projects: [<Route key="projects" path="/projects" element={<Projects />} />],
  memory: [<Route key="memory" path="/memory" element={<Memory />} />],
  org: [<Route key="org" path="/org/*" element={<Org />} />],
  board: [
    <Route key="board" path="/board" element={<BoardPage />} />,
    <Route key="board-card" path="/board/:cardId" element={<BoardPage />} />,
  ],
  usage: [
    <Route key="usage" path="/usage" element={<Usage />} />,
    <Route key="usage-live" path="/usage/live" element={<LiveAgents />} />,
    <Route key="usage-session" path="/usage/session/:host/:externalId" element={<UsageSession />} />,
  ],
};
