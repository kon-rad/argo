import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import DataTable, { PHONE_QUERY } from '../src/components/DataTable.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** jsdom lays nothing out: say how wide the scroller is and how wide its table, and whether this is a phone. */
function layout({ phone, box, content }: { phone: boolean; box: number; content: number }) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: phone && query === PHONE_QUERY, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(box);
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(content);
}

const RUNS = [
  { id: 'r1', agent: 'ada', model: 'model-large-2026', tokens: '1.2M', note: '' },
  { id: 'r2', agent: 'brook', model: 'model-small', tokens: '48k', note: 'retried once' },
];

function Runs({ phone, rows = RUNS }: { phone: 'cards' | 'scroll'; rows?: typeof RUNS }) {
  return (
    <DataTable label="Runs" phone={phone} className="w-full">
      <thead><tr><th>Agent</th><th>Model</th><th className="text-right">Tokens</th><th>Note</th><th></th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}><td>{r.agent}</td><td>{r.model}</td><td>{r.tokens}</td><td>{r.note}</td><td><button type="button">open</button></td></tr>
        ))}
        {rows.length === 0 && <tr><td colSpan={5}>No runs in this range.</td></tr>}
      </tbody>
    </DataTable>
  );
}

describe('DataTable, cards on a phone', () => {
  it('labels every body cell with its column header, so a card can print the label above the value', () => {
    render(<Runs phone="cards" />);
    const row = screen.getAllByRole('row')[1]!;
    expect([...row.children].map((td) => td.getAttribute('data-label'))).toEqual(['Agent', 'Model', 'Tokens', 'Note', null]);
    expect(screen.getByRole('table', { name: 'Runs' }).getAttribute('data-phone')).toBe('cards');
  });

  it('keeps table semantics with explicit roles, which survive rows and cells that are no longer display: table', () => {
    render(<Runs phone="cards" />);
    const table = screen.getByRole('table', { name: 'Runs' });
    expect(table.getAttribute('role')).toBe('table');
    expect(table.querySelectorAll('[role="rowgroup"]')).toHaveLength(2);
    expect(table.querySelectorAll('tr[role="row"]')).toHaveLength(3);
    expect(table.querySelectorAll('th[role="columnheader"]')).toHaveLength(5);
    expect(table.querySelectorAll('td[role="cell"]')).toHaveLength(10);
    // The action is still a real button in its own cell: nothing is hidden or folded away.
    expect(within(screen.getAllByRole('row')[2]!).getByRole('button', { name: 'open' })).toBeTruthy();
  });

  it('labels rows that arrive later, and leaves a cell that spans the table without a label', () => {
    const view = render(<Runs phone="cards" rows={[]} />);
    const empty = screen.getByText('No runs in this range.');
    expect(empty.getAttribute('data-label')).toBeNull();
    expect(empty.getAttribute('role')).toBe('cell');
    view.rerender(<Runs phone="cards" />);
    expect(screen.getByText('brook').getAttribute('data-label')).toBe('Agent');
    expect(screen.getByText('retried once').getAttribute('data-label')).toBe('Note');
  });
});

describe('DataTable, sideways scroll on a phone', () => {
  it('says the table scrolls, and makes the scroller a named region a keyboard can reach, when columns are off screen', () => {
    layout({ phone: true, box: 343, content: 720 });
    render(<Runs phone="scroll" />);
    const region = screen.getByRole('region', { name: 'Runs, scrolls sideways' });
    expect(region.tabIndex).toBe(0);
    expect(region.contains(screen.getByRole('table', { name: 'Runs' }))).toBe(true);
    expect(screen.getByText('Swipe sideways for more columns →')).toBeTruthy();
    expect(region.parentElement!.getAttribute('data-more-right')).toBe('true');
    expect(region.parentElement!.hasAttribute('data-more-left')).toBe(false);
  });

  it('follows the scroll position: columns hidden on the left once scrolled, none on the right at the end', () => {
    layout({ phone: true, box: 343, content: 720 });
    render(<Runs phone="scroll" />);
    const region = screen.getByRole('region');
    act(() => { region.scrollLeft = 377; fireEvent.scroll(region); });
    expect(region.parentElement!.getAttribute('data-more-left')).toBe('true');
    expect(region.parentElement!.hasAttribute('data-more-right')).toBe(false);
    expect(screen.getByText('← Swipe back to the first columns')).toBeTruthy();
  });

  it('adds nothing when every column fits', () => {
    layout({ phone: true, box: 343, content: 343 });
    render(<Runs phone="scroll" />);
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.queryByText(/Swipe/)).toBeNull();
    expect(screen.getByRole('table', { name: 'Runs' }).parentElement!.hasAttribute('tabindex')).toBe(false);
  });

  it('adds nothing on a desktop, even for a table wider than its box', () => {
    layout({ phone: false, box: 900, content: 1600 });
    render(<Runs phone="scroll" />);
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.queryByText(/Swipe/)).toBeNull();
    const table = screen.getByRole('table', { name: 'Runs' });
    expect(table.parentElement!.hasAttribute('tabindex')).toBe(false);
    // The table is a native one here: no stamped roles or labels to keep in step.
    expect(table.hasAttribute('role')).toBe(false);
    expect(table.querySelector('td[data-label]')).toBeNull();
  });
});
