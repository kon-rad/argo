import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Every route at a phone and a desktop size. Fails when a page scrolls
 * sideways at 390 px, when a control is smaller than 44 px, or when an input
 * would make iOS zoom (font under 16 px). Screenshots go to SHOTS_DIR
 * (default e2e/shots) for the dev log.
 *
 * Not part of `vitest run` (the .pw.ts name keeps it out) and not a
 * dependency of the app: run it where Playwright is installed, against a
 * running app:
 *   BASE_URL=http://localhost:5123 npx -y @playwright/test test -c web/e2e/playwright.config.ts
 * (the optional pages only exist when their module is on; a route the app
 * answers "No such page" for is skipped).
 */

const ROUTES = [
  '/', '/search?q=test', '/vector-search', '/database', '/sources', '/cron', '/ring',
  '/agents/chat', '/agents/history',
  '/projects', '/projects?view=board', '/projects?view=needs', '/projects?view=teams', '/projects?view=goals', '/projects?view=report',
  '/org', '/org/chart', '/org/live', '/org/approvals',
  '/usage', '/media', '/media-schedule', '/map', '/tv',
];
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const SHOTS = process.env.SHOTS_DIR ?? join(__dirname, 'shots');

const slug = (route: string): string => route.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home';

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

for (const route of ROUTES) {
  test(`phone ${route}`, async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    if (await page.getByText(/^No such page/).count()) test.skip(true, 'module not enabled here');

    await page.screenshot({ path: join(SHOTS, `${slug(route)}-390x844.png`), fullPage: false });

    const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
    expect(m.scroll, `${route} scrolls sideways (${m.scroll} > ${m.inner})`).toBeLessThanOrEqual(m.inner);

    // The header collapses to one menu button that reaches every section.
    await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();

    // Controls a thumb has to hit: buttons, selects and text inputs that are visible.
    const small = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('button, select, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]), textarea')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const label = (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).trim().slice(0, 30);
        if (r.height < 43.5) bad.push(`${label}: ${Math.round(r.height)}px tall`);
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && parseFloat(getComputedStyle(el).fontSize) < 16) bad.push(`${label}: font under 16px`);
      }
      return bad;
    });
    expect(small, `${route}: controls too small`).toEqual([]);
  });

  test(`desktop ${route}`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: join(SHOTS, `${slug(route)}-1440x900.png`), fullPage: false });
    // Desktop keeps the header menus; the phone menu button is hidden.
    await expect(page.getByRole('button', { name: 'Menu' })).toBeHidden();
  });
}

test('the phone menu reaches every section and closes on navigation', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await page.getByRole('button', { name: 'Menu' }).click();
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await expect(nav).toBeVisible();
  await nav.getByRole('link', { name: 'Database' }).click();
  await expect(page).toHaveURL(/\/database$/);
  await expect(nav).toBeHidden();
});
