import { NavLink } from 'react-router-dom';
import AgentSkills from './AgentSkills.js';
import Changes from './Changes.js';
import Library from './Library.js';
import Machines from './Machines.js';
import Matrix from './Matrix.js';
import SkillDetail from './SkillDetail.js';

export type SkillsView = 'library' | 'matrix' | 'machines' | 'changes' | 'detail' | 'agent';

const TABS: [string, string][] = [['/skills', 'Library'], ['/skills/matrix', 'Agents'], ['/skills/machines', 'Machines'], ['/skills/changes', 'Changes']];

/** The skills addon's pages under one header: the library, the agent matrix, machines and pending changes. */
export default function Skills({ view }: { view: SkillsView }) {
  return (
    <div className="flex h-full flex-col">
      <nav aria-label="Skills sections" className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--rule)] px-3 py-1 text-sm">
        {TABS.map(([to, label]) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/skills'}
            className={({ isActive }) =>
              `inline-flex min-h-9 items-center whitespace-nowrap rounded px-2 ${isActive || (to === '/skills/matrix' && view === 'agent') || (to === '/skills' && view === 'detail') ? 'bg-[var(--paper-sunk)] text-[var(--ink)]' : 'text-[var(--ink-dim)] hover:text-[var(--ink)]'}`}
          >
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === 'library' && <Library />}
        {view === 'matrix' && <Matrix />}
        {view === 'machines' && <Machines />}
        {view === 'changes' && <Changes />}
        {view === 'detail' && <SkillDetail />}
        {view === 'agent' && <AgentSkills />}
      </div>
    </div>
  );
}
