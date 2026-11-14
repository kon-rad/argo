import { useEffect, useId, useRef, type RefObject } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { currentItem, itemKey, type NavItem } from './NavMenu.js';

/**
 * Phone navigation: a menu button in the header opens a slide-over with every
 * section in one list, the current page highlighted. The desktop header menus
 * are hidden below the md breakpoint and this is hidden above it. Closes on
 * Escape, on the backdrop, on its own close button and on navigation.
 */
export function MenuButton({
  open,
  onToggle,
  controls,
  ref,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  ref?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label="Menu"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="ml-auto inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-xl text-[var(--ink)] md:hidden"
    >
      <span aria-hidden="true">☰</span>
    </button>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function MobileMenu({
  id,
  sections,
  open,
  onClose,
  search,
  footer,
  opener,
}: {
  id: string;
  sections: [string, NavItem[]][];
  open: boolean;
  onClose: () => void;
  /** The search box, so the phone has it inside the menu rather than squeezed into the header. */
  search: React.ReactNode;
  /** Status chips and the log out button. */
  footer: React.ReactNode;
  /** The menu button: focus goes back to it when the menu closes. */
  opener?: RefObject<HTMLElement | null>;
}) {
  const { pathname, search: query } = useLocation();
  // One current page at most: a note open under a Docs folder marks Docs, not Browse as well.
  const here = currentItem(sections, pathname);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Navigating (any link, the back button) closes the menu.
  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab') return;
      // The page behind is covered: Tab cycles inside the menu instead of walking out under it.
      const stops = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) return;
      const at = document.activeElement;
      const inside = panelRef.current?.contains(at) ?? false;
      if (e.shiftKey ? at === first || !inside : at === last || !inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
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

  // Focus moves into the menu when it opens (the close button, not the search box: that would raise
  // the keyboard) and back to the menu button when it closes.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const back = opener?.current;
    return () => back?.focus();
  }, [open, opener]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30 md:hidden">
      <div data-testid="menu-backdrop" aria-hidden="true" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-y-0 right-0 flex w-[min(20rem,88vw)] flex-col gap-3 overflow-y-auto overscroll-contain border-l border-[var(--rule)] bg-[var(--paper)] p-3 shadow-xl"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id={titleId} className="px-2 text-base font-semibold">Menu</h2>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close menu"
            onClick={onClose}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-xl text-[var(--ink)]"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div>{search}</div>
        <nav aria-label="Sections" className="flex flex-col gap-3">
          {sections.map(([label, items], n) => (
            <div key={label}>
              <h3 id={`${titleId}-${n}`} className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--ink-faint)]">{label}</h3>
              <ul aria-labelledby={`${titleId}-${n}`}>
                {items.map((i) => (
                  <li key={itemKey(i)}>
                    {i.to === undefined ? (
                      <button type="button" onClick={() => { onClose(); i.onSelect(); }}
                        className="flex min-h-11 w-full items-center rounded px-2 text-left text-base text-[var(--ink-dim)]">
                        {i.label}
                      </button>
                    ) : (
                      <Link
                        to={i.to}
                        onClick={onClose}
                        aria-current={i === here ? 'page' : undefined}
                        className={`flex min-h-11 items-center rounded px-2 text-base ${i === here ? 'bg-[var(--paper-sunk)] font-medium text-[var(--ink)]' : 'text-[var(--ink-dim)]'}`}
                      >
                        {i.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 border-t border-[var(--rule)] pt-3">{footer}</div>
      </div>
    </div>
  );
}
