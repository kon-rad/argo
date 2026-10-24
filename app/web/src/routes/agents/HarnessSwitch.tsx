import { NavLink } from 'react-router-dom';

/**
 * Which agent harness a chat runs on. Two today: Claude Code (agent-hub keeps a `claude -p` per chat) and zen-agent
 * (`zen-agent serve` keeps a live agent per chat). Hermes has no session API to drive from a browser yet, so it is
 * not offered here; its conversations are under History.
 */
const pill = ({ isActive }: { isActive: boolean }): string =>
  `rounded px-2 py-0.5 text-xs ${isActive ? 'bg-[var(--ink)] text-[var(--paper)]' : 'text-[var(--ink-dim)] hover:text-[var(--ink)]'}`;

export default function HarnessSwitch() {
  return (
    <nav className="flex gap-1 rounded border border-[var(--rule)] p-0.5" aria-label="Harness">
      <NavLink to="/agents/chat" className={pill}>Claude Code</NavLink>
      <NavLink to="/agents/zen" className={pill}>zen-agent</NavLink>
    </nav>
  );
}
