import { useQuery } from '@tanstack/react-query';
import { NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import Board from './Board.js';
import Chat from './Chat.js';
import History from './History.js';

/**
 * Agents: the shared kanban board (Hermes profiles + Claude Code lanes), chats with Claude Code on the droplet, and
 * the history of every Hermes conversation.
 */
const tab = ({ isActive }: { isActive: boolean }): string =>
  `px-3 py-1.5 text-sm border-b-2 ${isActive ? 'border-[var(--accent)] text-[var(--ink)]' : 'border-transparent text-[var(--ink-dim)] hover:text-[var(--ink)]'}`;

export default function Agents() {
  // With the board module on, the kanban lives at /board; the tab points there and old /agents/board links follow.
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Infinity });
  const engineBoard = (meta.data?.modules ?? []).includes('board');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav className="flex shrink-0 gap-1 overflow-x-auto whitespace-nowrap border-b border-[var(--rule)] px-3" aria-label="Agents">
        <NavLink to={engineBoard ? '/board' : '/agents/board'} className={tab}>Board</NavLink>
        <NavLink to="/agents/chat" className={tab}>Chat</NavLink>
        <NavLink to="/agents/history" className={tab}>History</NavLink>
      </nav>
      <div className="min-h-0 flex-1">
        <Routes>
          <Route index element={<Navigate to={engineBoard ? '/board' : 'board'} replace />} />
          <Route path="board" element={engineBoard ? <Navigate to="/board" replace /> : <Board />} />
          <Route path="board/:taskId" element={engineBoard ? <OldCardLink /> : <Board />} />
          <Route path="chat" element={<Chat />} />
          <Route path="chat/:chatId" element={<Chat />} />
          <Route path="history" element={<History />} />
          <Route path="history/:id" element={<History />} />
          {/* Old links (/agents/123) to a Hermes conversation. */}
          <Route path=":id" element={<OldHistoryLink />} />
        </Routes>
      </div>
    </div>
  );
}

function OldCardLink() {
  const { taskId } = useParams();
  return <Navigate to={`/board/${taskId}`} replace />;
}

function OldHistoryLink() {
  const { id } = useParams();
  return <Navigate to={`/agents/history/${id}`} replace />;
}
