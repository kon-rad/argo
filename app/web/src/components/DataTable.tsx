import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Below Tailwind's `md`: the same line every other phone rule in index.css uses. */
export const PHONE_QUERY = '(max-width: 767px)';

interface Props {
  /** What the table lists. Names the table for a screen reader, and its scroller when it has one. */
  label: string;
  /**
   * How the table reads on a phone. The desktop table is the same either way.
   * `cards`: every row becomes a card and every cell a tile under its column header. For rows that are read one at a time.
   * `scroll`: the table keeps its grid in its own sideways scroller, first column pinned. For rows that are compared.
   */
  phone: 'cards' | 'scroll';
  /** Classes of the `<table>`. */
  className?: string;
  /** `scroll` only: classes of the box around the hint and the scroller. */
  frameClassName?: string;
  /** `scroll` only: classes of the scroller, when it is more than `overflow-x-auto` (a height cap, a border). */
  scrollClassName?: string;
  /** The usual `<thead>` and `<tbody>`. */
  children: ReactNode;
}

/**
 * Gives a card table what CSS alone cannot: `data-label` on every body cell (its column header, which the phone
 * styles print above the value) and explicit table roles, because a browser drops a table's semantics once its
 * rows and cells stop being `display: table-*`. Attributes only, so React's own rendering is not disturbed.
 */
export function stampTable(table: HTMLTableElement): void {
  const heads = [...(table.tHead?.rows[0]?.cells ?? [])].map((th) => th.textContent?.trim() ?? '');
  table.setAttribute('role', 'table');
  for (const group of [table.tHead, ...table.tBodies, table.tFoot]) group?.setAttribute('role', 'rowgroup');
  for (const row of table.rows) {
    row.setAttribute('role', 'row');
    let column = 0;
    for (const cell of row.cells) {
      if (cell.tagName === 'TH') cell.setAttribute('role', cell.scope === 'row' ? 'rowheader' : 'columnheader');
      else {
        cell.setAttribute('role', 'cell');
        // A cell that spans columns (an empty-state line) belongs to no single header.
        const head = cell.colSpan === 1 ? heads[column] : '';
        if (head) cell.setAttribute('data-label', head); else cell.removeAttribute('data-label');
      }
      column += cell.colSpan;
    }
  }
}

function CardTable({ label, className, children }: Props) {
  const ref = useRef<HTMLTableElement>(null);
  // No dependency list: rows come and go with every render of the page that owns them.
  useLayoutEffect(() => { if (ref.current) stampTable(ref.current); });
  // Above the phone breakpoint this is the plain table it always was, and a wide one scrolls in its own box rather
  // than pushing the page sideways on a tablet or a narrow window. On a phone the cards fit, so nothing scrolls.
  return (
    <div className="overflow-x-auto max-md:overflow-x-visible">
      <table ref={ref} aria-label={label} data-phone="cards" className={className}>{children}</table>
    </div>
  );
}

function ScrollTable({ label, className, frameClassName, scrollClassName, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // Only a phone gets the hint, the pin shadow and the tab stop; a wide table on a desktop behaves as it always has.
      const phone = typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
      const hidden = phone ? el.scrollWidth - el.clientWidth : 0;
      const left = hidden > 1 && el.scrollLeft > 1;
      const right = hidden > 1 && el.scrollLeft < hidden - 1;
      setMore((was) => (was.left === left && was.right === right ? was : { left, right }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    sizes?.observe(el);
    if (el.firstElementChild) sizes?.observe(el.firstElementChild);
    return () => { el.removeEventListener('scroll', measure); sizes?.disconnect(); };
  }, []);
  const scrolls = more.left || more.right;
  return (
    <div className={frameClassName}>
      {scrolls && <p className="data-table-hint" aria-hidden="true">{more.right ? 'Swipe sideways for more columns →' : '← Swipe back to the first columns'}</p>}
      <div className="data-table-frame" data-more-left={more.left || undefined} data-more-right={more.right || undefined}>
        {/* A scroller nobody can focus cannot be scrolled from a keyboard, so it is a named region and a tab stop while it scrolls. */}
        <div ref={ref} className={`data-table-scroll ${scrollClassName ?? 'overflow-x-auto'}`}
          {...(scrolls ? { role: 'region', 'aria-label': `${label}, scrolls sideways`, tabIndex: 0 } : {})}>
          <table aria-label={label} data-phone="scroll" className={className}>{children}</table>
        </div>
      </div>
    </div>
  );
}

/**
 * A data table that stays readable at phone width without losing a column. Write the `<thead>` and `<tbody>` as
 * for any table and pick the phone pattern by what the reader does with the rows; the styles are in index.css
 * under "Data tables on a phone".
 */
export default function DataTable(props: Props) {
  return props.phone === 'cards' ? <CardTable {...props} /> : <ScrollTable {...props} />;
}
