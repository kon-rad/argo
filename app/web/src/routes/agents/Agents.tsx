import { NavLink, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import Chat from './Chat.js';
import History from './History.js';
import ZenChat from './ZenChat.js';

/**
 * Agents: chats with Claude Code or zen-agent on the
 * server (the Chat tab, with a harness switch), and the history of every Hermes conversation.
 */
const tab = ({ isActive }: { isActive: boolean }): string =>
  `px-3 py-1.5 text-sm border-b-2 ${isActive ? 'border-[var(--accent)] text-[var(--ink)]' : 'border-transparent text-[var(--ink-dim)] hover:text-[var(--ink)]'}`;

export default function Agents() {
  const location = useLocation();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav className="flex shrink-0 gap-1 overflow-x-auto whitespace-nowrap border-b border-[var(--rule)] px-3" aria-label="Agents">
        <NavLink to="/agents/chat" className={({ isActive }) => tab({ isActive: isActive || location.pathname.startsWith('/agents/zen') })}>Chat</NavLink>
        <NavLink to="/agents/history" className={tab}>History</NavLink>
      </nav>
      <div className="min-h-0 flex-1">
        <Routes>
          <Route index element={<Navigate to="chat" replace />} />
          {/* Old links to the Hermes kanban page land on the board. */}
          <Route path="board" element={<Navigate to="/board" replace />} />
          <Route path="board/:taskId" element={<OldCardLink />} />
          <Route path="chat" element={<Chat />} />
          <Route path="chat/:chatId" element={<Chat />} />
          <Route path="zen" element={<ZenChat />} />
          <Route path="zen/:chatId" element={<ZenChat />} />
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
