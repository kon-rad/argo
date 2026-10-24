import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, matchPath, useLocation } from 'react-router-dom';

/** A page link, or an action (the chat panel) that opens in place instead of navigating. */
export type NavItem = { to: string; label: string; end?: boolean; onSelect?: never } | { to?: never; label: string; onSelect: () => void; end?: never };

/** The key a list renders an item under: its path, else its label. */
export const itemKey = (i: NavItem): string => i.to ?? i.label;

/** One header menu: a button that opens a list of page links. Closes on Escape, outside click and navigation. */
export default function NavMenu({ label, items }: { label: string; items: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const location = useLocation();
  const active = items.some((i) => i.to !== undefined && matchPath({ path: i.to, end: i.end ?? false }, location.pathname) !== null);

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        data-active={active}
        onClick={() => setOpen((o) => !o)}
        className={`px-2 py-1 rounded ${active ? 'text-[var(--ink)] bg-[var(--paper-sunk)]' : 'text-[var(--ink-dim)] hover:text-[var(--ink)]'}`}
      >
        {label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div id={menuId} role="menu"
          className="absolute left-0 z-20 mt-1 min-w-40 rounded border border-[var(--rule)] bg-[var(--paper)] py-1 shadow-lg">
          {items.map((i) =>
            i.to === undefined ? (
              <button key={itemKey(i)} type="button" role="menuitem" onClick={() => { setOpen(false); i.onSelect(); }}
                className="block w-full px-3 py-1.5 text-left whitespace-nowrap text-[var(--ink-dim)] hover:text-[var(--ink)] hover:bg-[var(--paper-sunk)]">
                {i.label}
              </button>
            ) : (
              <NavLink key={itemKey(i)} to={i.to} end={i.end} role="menuitem" onClick={() => setOpen(false)}
                className={({ isActive }) => `block px-3 py-1.5 whitespace-nowrap ${isActive ? 'text-[var(--ink)] bg-[var(--paper-sunk)]' : 'text-[var(--ink-dim)] hover:text-[var(--ink)] hover:bg-[var(--paper-sunk)]'}`}>
                {i.label}
              </NavLink>
            ),
          )}
        </div>
      )}
    </div>
  );
}
