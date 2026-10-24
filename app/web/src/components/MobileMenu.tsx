import { useEffect, useId } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { itemKey, type NavItem } from './NavMenu.js';

/**
 * Phone navigation: a menu button in the header opens a slide-over with every
 * section in one list, the current page highlighted. The desktop header menus
 * are hidden below the md breakpoint and this is hidden above it. Closes on
 * Escape, on the backdrop, and on navigation.
 */
export function MenuButton({ open, onToggle, controls }: { open: boolean; onToggle: () => void; controls: string }) {
  return (
    <button
      type="button"
      aria-label="Menu"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="ml-auto inline-flex h-11 w-11 items-center justify-center rounded text-xl text-[var(--ink)] md:hidden"
    >
      <span aria-hidden="true">{open ? '×' : '☰'}</span>
    </button>
  );
}

export default function MobileMenu({
  id,
  sections,
  open,
  onClose,
  search,
  footer,
}: {
  id: string;
  sections: [string, NavItem[]][];
  open: boolean;
  onClose: () => void;
  /** The search box, so the phone has it inside the menu rather than squeezed into the header. */
  search: React.ReactNode;
  /** Status chips and the log out button. */
  footer: React.ReactNode;
}) {
  const { pathname, search: query } = useLocation();
  const titleId = useId();

  // Navigating (any link, the back button) closes the menu.
  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Keep the page behind from scrolling under the open menu.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30 md:hidden">
      <button type="button" aria-label="Close menu" tabIndex={-1} className="absolute inset-0 bg-black/40" onClick={onClose} />
      <nav
        id={id}
        aria-labelledby={titleId}
        className="absolute inset-y-0 right-0 flex w-[min(20rem,88vw)] flex-col gap-3 overflow-y-auto border-l border-[var(--rule)] bg-[var(--paper)] p-3 shadow-xl"
      >
        <h2 id={titleId} className="sr-only">Sections</h2>
        <div>{search}</div>
        {sections.map(([label, items]) => (
          <div key={label}>
            <div className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--ink-faint)]">{label}</div>
            <ul>
              {items.map((i) => (
                <li key={itemKey(i)}>
                  {i.to === undefined ? (
                    <button type="button" onClick={() => { onClose(); i.onSelect(); }}
                      className="flex min-h-11 w-full items-center rounded px-2 text-left text-base text-[var(--ink-dim)]">
                      {i.label}
                    </button>
                  ) : (
                    <NavLink
                      to={i.to}
                      end={i.end}
                      onClick={onClose}
                      className={({ isActive }) =>
                        `flex min-h-11 items-center rounded px-2 text-base ${isActive ? 'bg-[var(--paper-sunk)] font-medium text-[var(--ink)]' : 'text-[var(--ink-dim)]'}`
                      }
                    >
                      {i.label}
                    </NavLink>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="mt-auto flex flex-col gap-2 border-t border-[var(--rule)] pt-3">{footer}</div>
      </nav>
    </div>
  );
}
