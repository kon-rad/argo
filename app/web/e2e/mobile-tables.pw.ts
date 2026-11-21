import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { boardCards, CRON_JOB_ROUTE, FILE_ROUTE, NOW } from '../test/fixtures/tables.js';
import { mockApi } from './mock-api.js';

/**
 * Every view with a data table, in a real browser, at two phone widths and one desktop width. No server and no
 * database: tables.config.ts starts Vite and mock-api.ts answers /api from the fake data in test/fixtures/.
 *
 *   cd app && npm run e2e:install -w web     # once: a headless Chromium inside node_modules
 *   cd app && npm run e2e:tables -w web      # screenshots go to SHOTS_DIR (default web/e2e/shots)
 *
 * On a phone (375 and 390 px wide) a view fails when the page scrolls sideways, a table cell is cut off or pushed
 * off screen, a word is broken in the middle, a card tile has no label, a wide table does not say that it scrolls
 * or cannot bring its last column into view, or a link or button in a row is under 44 px tall.
 * At 1440 px it fails when a table is anything but the plain table it was: no cards, no hint, no pinned column.
 *
 * To compare desktop pixels with another revision, run the "desktop pixels" tests there with
 * `TABLES_BASELINE=<dir> ... -g "desktop pixels" --update-snapshots`, then here with the same TABLES_BASELINE.
 */

interface View {
  name: string;
  route: string;
  /** The DataTables on the view, by accessible name. */
  tables: { label: string; phone: 'cards' | 'scroll' }[];
  /** Something to do before the tables are there. */
  before?: (page: Page) => Promise<void>;
}

const VIEWS: View[] = [
  { name: 'projects-needs', route: '/projects?view=needs', tables: [{ label: 'Needs you', phone: 'cards' }] },
  { name: 'projects-goals', route: '/projects?view=goals', tables: [{ label: 'Goals', phone: 'cards' }] },
  { name: 'projects-report', route: '/projects?view=report', tables: [] },
  { name: 'board', route: '/board', tables: [] },
  {
    name: 'org-runtime-preview', route: '/org/runtime', tables: [{ label: 'Coverage ledger', phone: 'cards' }],
    before: async page => {
      await page.getByRole('button', { name: 'Preview change' }).press('Enter');
      await expect(page.getByRole('heading', { name: 'Review change' })).toBeFocused();
      await expect(page.getByRole('button', { name: 'Apply whole fleet' })).toBeDisabled();
      await expect(page.getByText('Default poller inactive')).toBeVisible();
    },
  },
  { name: 'org-approvals', route: '/org/approvals', tables: [{ label: 'Board tokens', phone: 'cards' }] },
  {
    name: 'database', route: '/database', tables: [{ label: 'Query results', phone: 'scroll' }],
    before: async (page) => {
      await page.getByLabel('SQL', { exact: true }).fill('select * from garden_beds');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
    },
  },
  { name: 'cron', route: '/cron', tables: [] },
  { name: 'cron-job', route: CRON_JOB_ROUTE, tables: [{ label: 'Runs', phone: 'cards' }] },
  {
    name: 'usage-ledger', route: '/usage?view=ledger&group=model',
    tables: [{ label: 'Tokens by model', phone: 'scroll' }, { label: 'Runs', phone: 'cards' }, { label: 'Agent wakes', phone: 'scroll' }],
  },
  { name: 'usage-sessions', route: '/usage?view=sessions', tables: [{ label: 'Sessions', phone: 'cards' }] },
  { name: 'usage-summaries', route: '/usage?view=summaries', tables: [{ label: 'Sessions by day', phone: 'scroll' }] },
  { name: 'usage-running', route: '/usage?view=running', tables: [] },
  { name: 'ring', route: '/ring', tables: [{ label: 'Every day', phone: 'scroll' }] },
  { name: 'fund', route: '/fund', tables: [{ label: 'Transactions', phone: 'cards' }, { label: 'Harness', phone: 'scroll' }] },
  { name: 'file-markdown', route: FILE_ROUTE, tables: [] },
];

const PHONES = [{ width: 375, height: 812 }, { width: 390, height: 844 }];
const DESKTOP = { width: 1440, height: 900 };
const SHOTS = process.env.SHOTS_DIR ?? join(import.meta.dirname, 'shots');

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

async function open(page: Page, view: View, size: { width: number; height: number }): Promise<void> {
  const api = await mockApi(page);
  await page.clock.setFixedTime(new Date(NOW));
  await page.setViewportSize(size);
  await page.goto(view.route);
  await view.before?.(page);
  for (const t of view.tables) await expect(page.getByRole('table', { name: t.label, exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(api.unmocked, 'API calls the fixtures did not answer').toEqual([]);
}

/**
 * The route-level overflow check. The app scrolls inside its own boxes, not the document, so a view that is too wide
 * shows up as one of those boxes scrolling sideways with the whole view in it. Every box that scrolls sideways has to
 * hold one table, code block, tab strip or a box marked data-scroll-scope; anything else is page-wide sideways scroll by another name.
 */
function viewScrollers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth) bad.push(`the document scrolls sideways (${document.documentElement.scrollWidth} > ${window.innerWidth})`);
    for (const el of [document.querySelector('main'), ...document.querySelectorAll<HTMLElement>('main *')]) {
      if (!el) continue;
      const s = getComputedStyle(el);
      if (!['auto', 'scroll'].includes(s.overflowX) || el.scrollWidth <= el.clientWidth + 1) continue;
      // [data-scroll-scope] names a box that scrolls sideways by design, such as the board's columns.
      const scoped = el.matches('table, pre, nav, .data-table-scroll, .prose table, [data-scroll-scope]')
        || (el.children.length === 1 && el.firstElementChild!.matches('table, pre'));
      if (!scoped) bad.push(`<${el.tagName.toLowerCase()} class="${el.className}"> scrolls sideways with more than a table in it (${el.scrollWidth} > ${el.clientWidth})`);
    }
    return bad;
  });
}

/** What is wrong with the tables on the page, measured in the page. An empty list is a pass. */
function measure(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    const vw = window.innerWidth;
    const name = (el: Element): string => `${el.closest('table')?.getAttribute('aria-label') ?? 'table'}: "${(el.textContent ?? '').trim().slice(0, 40)}"`;
    const shown = (el: Element): boolean => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

    if (document.documentElement.scrollWidth > vw) bad.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);

    // Anywhere on the view: a control squeezed narrower than its own label, so the text spills over its neighbour.
    for (const el of document.querySelectorAll<HTMLElement>('main button, main a, main [role="tab"]')) {
      if (!shown(el) || getComputedStyle(el).display === 'inline') continue;
      if (el.scrollWidth > el.clientWidth + 1) bad.push(`text spills out of "${(el.textContent ?? '').trim().slice(0, 40)}" (${el.scrollWidth} > ${el.clientWidth})`);
    }

    for (const table of document.querySelectorAll<HTMLTableElement>('main table')) {
      const scroller = table.closest<HTMLElement>('.data-table-scroll') ?? (getComputedStyle(table).overflowX === 'auto' ? table : null);
      const box = (scroller ?? document.documentElement).getBoundingClientRect();
      for (const cell of table.querySelectorAll<HTMLElement>('th, td')) {
        // The header of a card table is kept for screen readers and clipped out of sight on purpose.
        if (!shown(cell) || cell.closest('table[data-phone="cards"] > thead')) continue;
        // Cut off: more content than box, behind overflow hidden or an ellipsis.
        for (const el of [cell, ...cell.querySelectorAll<HTMLElement>('*')]) {
          const s = getComputedStyle(el);
          if (s.display === 'inline' || !shown(el)) continue;
          if ((s.overflowX === 'hidden' || s.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1) bad.push(`cut off sideways, ${name(el)}`);
          if ((s.overflowY === 'hidden' || s.overflowY === 'clip') && el.scrollHeight > el.clientHeight + 1) bad.push(`cut off below, ${name(el)}`);
        }
        // Off screen with no scroller of its own to bring it back.
        const r = cell.getBoundingClientRect();
        if (!scroller && (r.left < box.left - 1 || r.right > Math.min(box.right, vw) + 1)) bad.push(`off screen, ${name(cell)}`);
        // A word broken in the middle. Long unbroken strings (ids, hashes, URLs) may wrap, and so may a raw value
        // its view breaks anywhere on purpose (break-all); a word of prose may not.
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (getComputedStyle(node.parentElement!).wordBreak === 'break-all') continue;
          for (const m of (node.textContent ?? '').matchAll(/[\p{L}\p{N}]+/gu)) {
            if (m[0].length < 2 || m[0].length > 16) continue;
            const range = document.createRange();
            range.setStart(node, m.index);
            range.setEnd(node, m.index + m[0].length);
            const lines = new Set([...range.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top)));
            if (lines.size > 1) bad.push(`"${m[0]}" is broken across ${lines.size} lines, ${name(cell)}`);
          }
        }
      }
      // Thumb-sized links and buttons in the rows of a data table.
      if (table.dataset.phone) {
        for (const el of table.querySelectorAll<HTMLElement>('a, button, select, input')) {
          if (!shown(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.height < 43.5) bad.push(`${Math.round(r.height)} px tall link or button, ${name(el)}`);
        }
      }
    }

    for (const table of document.querySelectorAll<HTMLTableElement>('table[data-phone="cards"]')) {
      if (getComputedStyle(table.tHead!).display === 'none') bad.push(`${table.ariaLabel}: the header is removed, not just out of sight`);
      for (const cell of table.querySelectorAll<HTMLElement>('tbody > tr > td[data-label]')) {
        const label = getComputedStyle(cell, '::before').content;
        if (!label.includes(cell.dataset.label!)) bad.push(`no "${cell.dataset.label}" label on its tile, ${name(cell)}`);
      }
    }
    return bad;
  });
}

/** A scroll table: says that it scrolls while columns are off screen, keeps the first column, and reaches the last. */
async function checkScroller(page: Page, label: string): Promise<void> {
  const table = page.getByRole('table', { name: label, exact: true });
  const scroller = page.locator('.data-table-scroll').filter({ has: table });
  const frame = page.locator('.data-table-frame').filter({ has: table });
  const m = await scroller.evaluate((el) => ({ hidden: el.scrollWidth - el.clientWidth }));
  if (m.hidden <= 1) {
    // Every column fits at this width: then nothing claims otherwise.
    await expect(frame.locator('xpath=preceding-sibling::p')).toHaveCount(0);
    return;
  }
  await expect(page.getByRole('region', { name: `${label}, scrolls sideways` })).toBeVisible();
  await expect(scroller).toHaveAttribute('tabindex', '0');
  await expect(frame).toHaveAttribute('data-more-right', 'true');
  const hint = frame.locator('xpath=preceding-sibling::p');
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText('Swipe sideways for more columns →');

  // A keyboard scrolls it: focus the region, press an arrow key. Retried as a unit: under a loaded parallel run a single
  // key press could land before the page settled and then nothing would ever press it again.
  await expect(async () => {
    await scroller.focus();
    await expect(scroller).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => scroller.evaluate((el) => el.scrollLeft), { timeout: 2000 }).toBeGreaterThan(0);
  }).toPass({ timeout: 15000 });

  // At the far end the last column is fully in view and the first is still there, pinned.
  await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await expect(frame).toHaveAttribute('data-more-left', 'true');
  await expect(frame).not.toHaveAttribute('data-more-right', 'true');
  await expect(hint).toHaveText('← Swipe back to the first columns');
  const end = await scroller.evaluate((el) => {
    const row = el.querySelector('tbody tr')!;
    // The inside of the scroller: its box without border or scrollbar.
    const left = el.getBoundingClientRect().left + el.clientLeft;
    const first = row.firstElementChild!.getBoundingClientRect();
    const last = row.lastElementChild!.getBoundingClientRect();
    return { firstLeft: first.left - left, lastRight: last.right - (left + el.clientWidth), room: el.clientWidth - first.width };
  });
  expect(Math.abs(end.firstLeft), `${label}: the first column stays at the left edge`).toBeLessThanOrEqual(1.5);
  expect(end.lastRight, `${label}: the last column comes fully into view`).toBeLessThanOrEqual(1.5);
  expect(end.room, `${label}: room beside the pinned column`).toBeGreaterThan(120);
  await scroller.evaluate((el) => { el.scrollLeft = 0; });
}

for (const size of PHONES) {
  test.describe(`phone ${size.width}`, () => {
    for (const view of VIEWS) {
      test(`${view.name}`, async ({ page }) => {
        await open(page, view, size);
        await page.screenshot({ path: join(SHOTS, `${view.name}-${size.width}.png`), fullPage: true });
        expect(await measure(page), `${view.route} at ${size.width} px`).toEqual([]);
        expect(await viewScrollers(page), `${view.route} at ${size.width} px`).toEqual([]);
        for (const t of view.tables) {
          const table = page.getByRole('table', { name: t.label, exact: true });
          // The page screenshot stops at the fold of the app's own scroller; this one is the screen with the table at the
          // top (and its scroll hint, when it has one), as a reader sees it.
          await table.evaluate((el) => {
            const frame = el.closest('.data-table-frame');
            const hint = frame?.previousElementSibling?.tagName === 'P' ? frame.previousElementSibling : null;
            (hint ?? frame ?? el).scrollIntoView({ block: 'start' });
          });
          await page.screenshot({ path: join(SHOTS, `${view.name}-${size.width}-${t.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`) });
          await table.evaluate(() => document.querySelector('main')?.scrollTo(0, 0));
          await expect(table).toHaveAttribute('data-phone', t.phone);
          if (t.phone === 'scroll') await checkScroller(page, t.label);
          else await expect(table).toHaveCSS('display', 'block');
        }
        // The same, after the sideways scrolling above.
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      });
    }

    test('board: one column per screen, the next one showing, and a jump to any of them', async ({ page }) => {
      await open(page, VIEWS.find((v) => v.name === 'board')!, size);
      const jump = page.getByRole('combobox', { name: 'Jump to column' });
      await expect(jump).toBeVisible();
      expect((await jump.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
      const columns = page.locator('section[id^="board-col-"]');
      const first = (await columns.nth(0).boundingBox())!;
      const second = (await columns.nth(1).boundingBox())!;
      expect(first.width).toBeGreaterThan(size.width * 0.8);
      expect(second.x, 'the next column shows at the edge').toBeLessThan(size.width - 24);
      await jump.selectOption({ index: 4 });
      await expect.poll(async () => Math.round((await columns.nth(3).boundingBox())!.x)).toBeLessThanOrEqual(16);
      await page.screenshot({ path: join(SHOTS, `board-jumped-${size.width}.png`) });
    });

    test('board: only a sourced card has the Cybazaar rail and Desk link', async ({ page }) => {
      await mockApi(page);
      const sourced = boardCards.cards.map((card) => card.id === 't_0a11'
        ? { ...card, contract: { ...card.contract, cybazaarJobId: 'market-job-42', deskJobRef: 'arkiv:test/job-42' } } : card);
      await page.route('**/api/board/cards**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        const id = path.split('/').at(-1);
        const card = sourced.find((candidate) => candidate.id === id);
        await route.fulfill({ json: card
          ? { card, comments: [], events: [], depends_on: [], dependants: [], runs: [] }
          : { cards: sourced } });
      });
      await page.setViewportSize(size);
      await page.goto('/board');
      const marked = page.getByText('Sort the inbox of testers who replied to the beta form and mark shared households').locator('xpath=ancestor::li[1]');
      await expect(marked.getByText('Cybazaar')).toBeVisible();
      await expect(marked).toHaveCSS('border-left-color', 'rgb(104, 223, 255)');
      const plain = page.getByText('Idea: export a bed as a printable planting plan').locator('xpath=ancestor::li[1]');
      await expect(plain.getByText('Cybazaar')).toHaveCount(0);
      await page.screenshot({ path: join(SHOTS, `board-cybazaar-list-${size.width}.png`) });
      await marked.getByRole('button').click();
      await expect(page.getByRole('link', { name: 'Open Desk job' })).toHaveAttribute('href', '/desk?job=arkiv%3Atest%2Fjob-42');
      await page.screenshot({ path: join(SHOTS, `board-cybazaar-${size.width}.png`) });
    });

    test('cron: every job row is a thumb-sized link', async ({ page }) => {
      await open(page, VIEWS.find((v) => v.name === 'cron')!, size);
      const rows = page.locator('aside table tr');
      expect(await rows.count()).toBeGreaterThan(0);
      for (const row of await rows.all()) {
        expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
        await expect(row.getByRole('link')).toHaveCount(1);
      }
      await rows.first().getByRole('link').focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/cron\/[^/]+\/[^/]+$/);
    });

    test('ring: a night opens from its day with a tap or the keyboard', async ({ page }) => {
      await open(page, VIEWS.find((v) => v.name === 'ring')!, size);
      const day = page.getByRole('table', { name: 'Every day' }).getByRole('button').nth(1);
      const night = page.waitForRequest(/\/api\/ring\/night\//);
      await day.focus();
      await page.keyboard.press('Enter');
      await night;
    });

    test('markdown table: whole words, scrolls in its own box', async ({ page }) => {
      await open(page, VIEWS.find((v) => v.name === 'file-markdown')!, size);
      const table = page.locator('.prose table').first();
      await expect(table).toBeVisible();
      const m = await table.evaluate((el) => ({ overflow: getComputedStyle(el).overflowX, hidden: el.scrollWidth - el.clientWidth, right: el.getBoundingClientRect().right }));
      expect(m.overflow).toBe('auto');
      expect(m.right).toBeLessThanOrEqual(size.width);
      expect(m.hidden, 'the fixture table is wider than a phone').toBeGreaterThan(0);
    });
  });
}

// Just above the phone breakpoint the desktop table is back, with all its columns: a wide one scrolls in its own
// box, never the page.
test.describe('tablet 800', () => {
  for (const view of VIEWS) {
    test(`${view.name}`, async ({ page }) => {
      await open(page, view, { width: 800, height: 1024 });
      expect(await viewScrollers(page), `${view.route} at 800 px`).toEqual([]);
    });
  }
});

test.describe('desktop 1440', () => {
  for (const view of VIEWS) {
    test(`${view.name}`, async ({ page }) => {
      await open(page, view, DESKTOP);
      await page.screenshot({ path: join(SHOTS, `${view.name}-1440.png`), fullPage: true });
      expect(await viewScrollers(page), `${view.route} at 1440 px`).toEqual([]);
      await expect(page.locator('.data-table-hint')).toHaveCount(0);
      await expect(page.locator('.data-table-scroll[tabindex], .data-table-scroll[role]')).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: 'Jump to column' })).toBeHidden();
      // Every table is a table: header row on screen, cells in columns, nothing pinned and no labels printed.
      const wrong = await page.evaluate(() => {
        const bad: string[] = [];
        for (const table of document.querySelectorAll<HTMLTableElement>('table[data-phone]')) {
          const label = table.ariaLabel;
          if (getComputedStyle(table).display !== 'table') bad.push(`${label}: display ${getComputedStyle(table).display}`);
          if (table.tHead && table.tHead.getBoundingClientRect().height < 1) bad.push(`${label}: no header row`);
          const row = table.tBodies[0]?.rows[0];
          if (!row) continue;
          if (getComputedStyle(row).display !== 'table-row') bad.push(`${label}: row is ${getComputedStyle(row).display}`);
          for (const cell of row.cells) {
            const s = getComputedStyle(cell);
            if (s.display !== 'table-cell') bad.push(`${label}: cell is ${s.display}`);
            if (s.position === 'sticky') bad.push(`${label}: a cell is pinned`);
            if (!['none', 'normal'].includes(getComputedStyle(cell, '::before').content)) bad.push(`${label}: a label is printed in a cell`);
          }
        }
        return bad;
      });
      expect(wrong, `${view.route} at 1440 px`).toEqual([]);
    });

    test(`desktop pixels ${view.name}`, async ({ page }) => {
      test.skip(!process.env.TABLES_BASELINE, 'set TABLES_BASELINE to a folder of screenshots from the revision to compare with');
      const api = await mockApi(page);
      await page.clock.setFixedTime(new Date(NOW));
      await page.setViewportSize(DESKTOP);
      await page.goto(view.route);
      await view.before?.(page);
      await page.waitForLoadState('networkidle');
      expect(api.unmocked).toEqual([]);
      await expect(page).toHaveScreenshot(`${view.name}-1440.png`, { fullPage: true, maxDiffPixels: 0, animations: 'disabled' });
    });
  }
});
