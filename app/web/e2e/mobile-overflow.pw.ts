import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Every route at two phone widths and a desktop size. Fails when a page (or
 * the phone scroll box, main) scrolls sideways, when a control is cut off by
 * the edge of the screen, when a control or a subnavigation link is smaller
 * than 44 px, or when an input would make iOS zoom (font under 16 px).
 * Screenshots go to SHOTS_DIR (default e2e/shots) for the dev log.
 *
 * Not part of `vitest run` (the .pw.ts name keeps it out) and not a
 * dependency of the app: install Playwright beside it without saving, then
 * run it against a running app:
 *   npm install --no-save @playwright/test && npx playwright install chromium
 *   BASE_URL=http://localhost:5123 npx playwright test -c web/e2e/playwright.config.ts
 * (the optional pages only exist when their module is on; a route the app
 * answers "No such page" for is skipped).
 */

const ROUTES = [
  '/', '/search?q=test', '/vector-search', '/database', '/sources', '/cron', '/ring', '/memory',
  '/agents/chat', '/agents/zen', '/agents/history',
  '/projects', '/projects?view=board', '/projects?view=needs', '/projects?view=teams', '/projects?view=goals', '/projects?view=report',
  '/org', '/org/chart', '/org/live', '/org/approvals',
  '/board', '/usage', '/usage?view=account', '/usage/live', '/desk',
  '/media', '/uploads', '/fund', '/map', '/tv',
];
const PHONES = [{ width: 375, height: 667 }, { width: 390, height: 844 }];
const DESKTOP = { width: 1440, height: 900 };
const SHOTS = process.env.SHOTS_DIR ?? join(import.meta.dirname, 'shots');

const slug = (route: string): string => route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home';

async function open(page: Page, route: string, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await page.goto(route);
  await page.waitForLoadState('networkidle');
  if (await page.getByText(/^No such page/).count()) test.skip(true, 'module not enabled here');
  await page.screenshot({ path: join(SHOTS, `${slug(route)}-${size.width}x${size.height}.png`), fullPage: false });
}

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

for (const route of ROUTES) {
  for (const phone of PHONES) {
    test(`phone ${phone.width} ${route}`, async ({ page }) => {
      await open(page, route, phone);

      // Neither the document nor main (the phone scroll box) scrolls sideways.
      const m = await page.evaluate(() => {
        const main = document.querySelector('main');
        return { doc: document.documentElement.scrollWidth, inner: window.innerWidth, main: main?.scrollWidth ?? 0, box: main?.clientWidth ?? 0 };
      });
      expect(m.doc, `${route} scrolls sideways (${m.doc} > ${m.inner})`).toBeLessThanOrEqual(m.inner);
      expect(m.main, `${route}: main scrolls sideways (${m.main} > ${m.box})`).toBeLessThanOrEqual(m.box);

      // The header collapses to one menu button that reaches every section.
      await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();

      const bad = await page.evaluate(() => {
        const out: string[] = [];
        const name = (el: HTMLElement): string => (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 30);
        // A control inside a strip that scrolls sideways on purpose (tab strips, the board lanes) is not clipped.
        const scrolls = (el: HTMLElement): boolean => {
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const x = getComputedStyle(p).overflowX;
            if ((x === 'auto' || x === 'scroll') && p.scrollWidth > p.clientWidth) return true;
          }
          return false;
        };
        const controls = 'button, select, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]), textarea';
        for (const el of document.querySelectorAll<HTMLElement>(controls)) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          // Controls a thumb has to hit.
          if (r.height < 43.5) out.push(`${name(el)}: ${Math.round(r.height)}px tall`);
          if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && parseFloat(getComputedStyle(el).fontSize) < 16) out.push(`${name(el)}: font under 16px`);
          if ((r.left < -0.5 || r.right > window.innerWidth + 0.5) && !scrolls(el)) out.push(`${name(el)}: cut off at the screen edge`);
        }
        // Subnavigation: the links of every tab strip.
        for (const el of document.querySelectorAll<HTMLElement>('main nav[aria-label] > a')) {
          const r = el.getBoundingClientRect();
          if (r.height > 0 && r.height < 43.5) out.push(`${name(el)}: subnav link ${Math.round(r.height)}px tall`);
        }
        return out;
      });
      expect(bad, `${route}: controls too small or clipped`).toEqual([]);
    });
  }

  test(`desktop ${route}`, async ({ page }) => {
    await open(page, route, DESKTOP);
    // Desktop keeps the header menus; the phone menu button is hidden.
    await expect(page.getByRole('button', { name: 'Menu' })).toBeHidden();
    const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth }));
    expect(m.doc, `${route} scrolls sideways (${m.doc} > ${m.inner})`).toBeLessThanOrEqual(m.inner);
  });
}

test('the phone menu reaches every section and closes on navigation', async ({ page }) => {
  await page.setViewportSize(PHONES[0]!);
  await page.goto('/');
  await page.getByRole('button', { name: 'Menu' }).click();
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Browse' })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('link', { name: 'Database' }).click();
  await expect(page).toHaveURL(/\/database$/);
  await expect(nav).toBeHidden();
  // The header says where that was.
  await expect(page.getByRole('banner').getByText('Database')).toBeVisible();
});

test('the phone menu works from the keyboard: focus moves in, Tab stays in, Escape gives focus back', async ({ page }) => {
  await page.setViewportSize(PHONES[0]!);
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Menu' });
  await button.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Close menu' })).toBeFocused();
  // Shift+Tab from the first stop wraps to the last, still inside the menu.
  await page.keyboard.press('Shift+Tab');
  expect(await menu.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Tab');
  await expect(menu.getByRole('button', { name: 'Close menu' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();
});

test('the phone menu closes on a tap outside it', async ({ page }) => {
  await page.setViewportSize(PHONES[0]!);
  await page.goto('/');
  await page.getByRole('button', { name: 'Menu' }).click();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu).toBeVisible();
  await page.mouse.click(10, 300);
  await expect(menu).toBeHidden();
});
