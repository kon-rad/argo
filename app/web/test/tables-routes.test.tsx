import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import App from '../src/App.js';
import { PHONE_QUERY } from '../src/components/DataTable.js';
import { answer } from './fixtures/api.js';
import * as fx from './fixtures/tables.js';

/**
 * Every route that shows a data table, rendered through the real route table from the fake data in fixtures/. jsdom
 * lays nothing out, so this checks what layout is built on: which phone pattern each table takes, that no column is
 * left out of it, and that the links and actions of a row are real links and buttons. The widths, wrapping and tap
 * targets themselves are checked in a browser by e2e/mobile-tables.pw.ts.
 */

let unmocked: string[] = [];

beforeEach(() => {
  unmocked = [];
  vi.stubGlobal('EventSource', undefined);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://app.test');
    const method = init?.method ?? 'GET';
    const reply = answer(method, url);
    if ('body' in reply) return Response.json(reply.body);
    if (!reply.quiet) unmocked.push(`${method} ${url.pathname}`);
    return Response.json({ error: 'not mocked' }, { status: 404 });
  }));
  // A phone whose screen is narrower than every table: 343 px of room for 720 px of columns.
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === PHONE_QUERY, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(343);
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(720);
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  expect(unmocked, 'API calls the fixtures did not answer').toEqual([]);
});

function open(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}><App /></MemoryRouter></QueryClientProvider>);
}

const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

/** The table called `name`, once its first data row is in: checked for its pattern and that it shows every column. */
async function table(name: string, phone: 'cards' | 'scroll', columns: string[]): Promise<HTMLTableElement> {
  const el = await screen.findByRole('table', { name }, { timeout: 4000 }) as HTMLTableElement;
  await within(el).findAllByRole('cell', {}, { timeout: 4000 });
  expect(el.getAttribute('data-phone'), `${name}: phone pattern`).toBe(phone);
  expect([...el.tHead!.rows[0]!.cells].map(text), `${name}: columns`).toEqual(columns);
  const rows = [...el.tBodies[0]!.rows].filter((r) => r.cells[0]!.colSpan === 1);
  expect(rows.length, `${name}: the fixture has rows`).toBeGreaterThan(0);
  for (const row of rows) {
    // Every column is still a cell of the row on a phone: nothing is dropped to make it fit.
    expect(row.cells.length, `${name}: cells in a row`).toBe(columns.length);
    for (const cell of row.cells) expect(cell.hidden || cell.classList.contains('hidden') || cell.className.includes('max-md:hidden'), `${name}: hidden cell`).toBe(false);
    if (phone === 'cards') {
      // A card prints each value under the name of its column.
      expect([...row.cells].map((c) => c.getAttribute('data-label') ?? ''), `${name}: card labels`).toEqual(columns);
    }
  }
  if (phone === 'scroll') {
    // The scroller says that it scrolls, by sight and to a screen reader, and a keyboard can focus it to scroll it.
    const region = el.closest('[role="region"]') as HTMLElement;
    expect(region?.getAttribute('aria-label'), `${name}: scroll region`).toBe(`${name}, scrolls sideways`);
    expect(region.tabIndex).toBe(0);
    expect(region.parentElement!.getAttribute('data-more-right')).toBe('true');
    expect(text(region.parentElement!.previousElementSibling!)).toBe('Swipe sideways for more columns →');
    // Native table semantics: no roles written over them.
    expect(el.hasAttribute('role')).toBe(false);
  } else {
    expect(el.closest('[role="region"]'), `${name}: cards do not scroll`).toBeNull();
    expect(el.getAttribute('role')).toBe('table');
  }
  return el;
}

describe('table views on a phone, from the app data shapes', () => {
  it('Projects, Needs you: one card per item, with its action', async () => {
    open('/projects?view=needs');
    const t = await table('Needs you', 'cards', ['Priority', 'Area / project', 'What you need to do', 'Due', '']);
    for (const row of t.tBodies[0]!.rows) expect(within(row).getByRole('button', { name: 'done' })).toBeTruthy();
  });

  it('Projects, Goals: one card per goal', async () => {
    open('/projects?view=goals');
    await table('Goals', 'cards', ['Goal', 'Horizon', 'Status', 'Due', 'Linked work']);
  });

  it('Org, Approvals: board tokens as cards, each with its revoke action', async () => {
    open('/org/approvals');
    const t = await table('Board tokens', 'cards', ['Acts as', 'Label', 'Last seen', 'Made', '']);
    expect(within(t).getAllByRole('button').length).toBeGreaterThan(0);
  });

  it('Database: query results scroll sideways with every column of the result', async () => {
    open('/database');
    fireEvent.click((await screen.findAllByRole('button', { name: /Query this table/ }, { timeout: 4000 }))[0]!);
    await table('Query results', 'scroll', fx.dbQueryResult.columns);
  });

  it('Cron: every job is a link, and the runs of a job are cards with the transcript link', async () => {
    open(fx.CRON_JOB_ROUTE);
    const t = await table('Runs', 'cards', ['Started', 'Took', 'Status', 'Transcript']);
    expect(within(t).getAllByRole('link', { name: /msgs$/ }).length).toBeGreaterThan(0);
    for (const j of fx.cronJobs.jobs) {
      expect(screen.getByRole('link', { name: j.name }).getAttribute('href')).toBe(`/cron/${encodeURIComponent(j.profile)}/${encodeURIComponent(j.job_id)}`);
    }
    expect(screen.getAllByRole('link', { current: 'page' }).map(text)).toContain(fx.cronJobDetail.job.name);
  });

  it('Usage, Ledger: the breakdown and the wakes scroll, the runs are cards, and filters stay buttons', async () => {
    open('/usage?view=ledger&group=model');
    const by = await table('Tokens by model', 'scroll', ['model', 'Calls', 'Tokens', 'Share', 'Output', 'Per call']);
    expect(within(by).getAllByRole('button', { name: /./ }).length).toBeGreaterThan(0);
    const runs = await table('Runs', 'cards', ['When', 'Who', 'Woken by', 'Card', 'Project', 'Work', 'Tokens', 'Output', 'Cost', 'Turns', 'Min', 'Verify']);
    expect(within(runs.tBodies[0]!.rows[0]!).getAllByRole('link').length).toBeGreaterThan(0);
    const wakes = await table('Agent wakes', 'scroll', ['Agent', 'Team', 'Wakes', 'Done', 'Open', 'Routine', 'DM', 'Mention', 'Card', 'Tokens', 'Avg min', 'Last']);
    expect(within(wakes).getAllByRole('button', { name: 'filter' })).toHaveLength(fx.usageOrgWakes.agents.length);
  });

  it('Usage, Sessions: fifteen fields per session, all of them on its card', async () => {
    open('/usage?view=sessions');
    const t = await table('Sessions', 'cards', ['Started', 'Duration', 'Machine', 'Type', 'Bot persona', 'Agent', 'Session', 'Ticket', 'Model', 'Steps',
      'Tool calls', 'Tokens in / out', 'Context', 'USD (Hermes)', 'Subagents']);
    expect(within(t).getAllByRole('link').length).toBeGreaterThanOrEqual(fx.agentSessions.sessions.length);
  });

  it('Usage, Summaries: sessions by day scroll', async () => {
    open('/usage?view=summaries');
    await table('Sessions by day', 'scroll', ['Day', 'Sessions', 'Stuck', 'Errors / session', 'Tokens']);
  });

  it('Ring: the days scroll, and a night opens from a button on its day', async () => {
    open('/ring');
    const t = await table('Every day', 'scroll', ['Day', 'Score', 'Asleep', 'Deep', 'REM', 'HRV', 'Resting HR', 'Steps', 'Recovery']);
    const scored = fx.ringOverview.days.filter((d) => d.sleep_score != null);
    expect(within(t).getAllByRole('button').map(text)).toEqual(scored.map((d) => d.day));
    fireEvent.click(within(t).getByRole('button', { name: scored[1]!.day }));
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.map((c) => String(c[0]))).toContain(`/api/ring/night/${scored[1]!.day}`));
  });

  it('Fund: transactions are cards and the harness table scrolls', async () => {
    open('/fund');
    await table('Transactions', 'cards', ['When', 'Type', 'What', 'On chain', 'Tx']);
    await table('Harness', 'scroll', fx.fundOverview.harness!.header);
  });

  it('Cron, the job list: a row is one link, and a click anywhere on the row follows it', async () => {
    open('/cron');
    const other = fx.cronJobs.jobs[1]!;
    const link = await screen.findByRole('link', { name: other.name }, { timeout: 4000 });
    expect(screen.queryByRole('link', { current: 'page' })).toBeNull();
    fireEvent.click(link.closest('tr')!.cells[1]!);
    expect((await screen.findByRole('link', { current: 'page' }, { timeout: 4000 })).textContent).toBe(other.name);
  });

  it('the views with no data table of their own load from the same fixtures', async () => {
    const report = open('/projects?view=report');
    expect((await screen.findAllByRole('table', {}, { timeout: 4000 })).every((t) => t.closest('.prose'))).toBe(true);
    report.unmount();
    const file = open(fx.FILE_ROUTE);
    // A table written in markdown, and the frontmatter under it.
    expect((await screen.findAllByRole('table', {}, { timeout: 4000 })).length).toBeGreaterThanOrEqual(2);
    file.unmount();
    open('/usage?view=running');
    expect(await screen.findByText(fx.usageLive.machines[0]!.display, {}, { timeout: 4000 })).toBeTruthy();
  });

  it('Board: a phone can jump to any column, each named with its card count', async () => {
    open('/board');
    const jump = await screen.findByRole('combobox', { name: 'Jump to column' }, { timeout: 4000 }) as HTMLSelectElement;
    await screen.findAllByText(fx.boardCards.cards[0]!.title, {}, { timeout: 4000 });
    const options = [...jump.options].filter((o) => o.value);
    const sections = screen.getAllByRole('region').filter((s) => s.id.startsWith('board-col-'));
    expect(options.map((o) => o.value)).toEqual(sections.map((s) => s.id.replace('board-col-', '')));
    expect(options.reduce((n, o) => n + Number(/\((\d+)\)$/.exec(o.text)![1]), 0)).toBe(within(screen.getByRole('main')).getAllByRole('listitem').length);
    const into = vi.fn();
    sections[2]!.scrollIntoView = into;
    fireEvent.change(jump, { target: { value: options[2]!.value } });
    expect(into).toHaveBeenCalledWith({ inline: 'start', block: 'nearest', behavior: 'smooth' });
  });
});
