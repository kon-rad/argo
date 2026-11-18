import { lazy, Suspense, type ReactElement } from 'react';
import { Route } from 'react-router-dom';
import BoardPage from './routes/board/Board.js';
import Memory from './routes/Memory.js';
import Org from './routes/org/Org.js';
import AreaPage from './routes/areas/AreaPage.js';
import Areas from './routes/areas/Areas.js';
import ProjectDetail, { OldAreaLink } from './routes/areas/ProjectDetail.js';
import Projects from './routes/Projects.js';
import LiveAgents from './routes/usage/LiveAgents.js';
import Usage from './routes/usage/Usage.js';
import UsageSession from './routes/usage/UsageSession.js';

const Desk = lazy(() => import('./routes/Desk.js'));
const Skills = lazy(() => import('./routes/skills/Skills.js'));
const skills = (view: 'library' | 'matrix' | 'machines' | 'changes' | 'detail' | 'agent') => <Suspense fallback={null}><Skills view={view} /></Suspense>;

/**
 * The page routes of each core feature, by module name. The server's manifest
 * (server/src/features/<name>/manifest.ts) owns the nav link and the API; this map
 * is the web half: which components answer the paths the manifest links to. App.tsx
 * renders the entries of the modules /api/meta says are on.
 */
export const FEATURE_ROUTES: Record<string, ReactElement[]> = {
  projects: [
    <Route key="areas" path="/areas" element={<Areas />} />,
    <Route key="area" path="/areas/:slug" element={<AreaPage />} />,
    <Route key="projects" path="/projects" element={<Projects />} />,
    <Route key="project" path="/projects/:area/:slug" element={<ProjectDetail />} />,
    // The address an area had before it got its own page.
    <Route key="projects-old-area" path="/projects/:area" element={<OldAreaLink />} />,
  ],
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
  desk: [<Route key="desk" path="/desk" element={<Suspense fallback={null}><Desk /></Suspense>} />],
  skills: [
    <Route key="skills" path="/skills" element={skills('library')} />,
    <Route key="skills-matrix" path="/skills/matrix" element={skills('matrix')} />,
    <Route key="skills-machines" path="/skills/machines" element={skills('machines')} />,
    <Route key="skills-changes" path="/skills/changes" element={skills('changes')} />,
    <Route key="skills-skill" path="/skills/s/:name" element={skills('detail')} />,
    <Route key="skills-agent" path="/skills/agents/:agent" element={skills('agent')} />,
  ],
};
