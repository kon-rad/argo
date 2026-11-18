import type { Page, Route } from '@playwright/test';
import { answer } from '../test/fixtures/api.js';

/**
 * Answers every /api call the page makes from the fixtures, so the app renders with no server and no database.
 * Whatever it has no answer for gets a 404 and is listed in `unmocked`, for the test to assert on.
 */
export async function mockApi(page: Page): Promise<{ unmocked: string[] }> {
  const unmocked: string[] = [];
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    // The glob also matches a source file that happens to sit in a folder called api: leave those to Vite.
    if (!url.pathname.startsWith('/api/')) return route.fallback();

    // 204 tells EventSource to stop; any error status would have it reconnect for the whole test.
    const accept = (await request.headerValue('accept')) ?? '';
    if (/\/(events|stream)$/.test(url.pathname) || accept.includes('text/event-stream')) return route.fulfill({ status: 204, body: '' });

    const reply = answer(request.method(), url);
    if ('body' in reply) return route.fulfill({ json: reply.body });
    if (!reply.quiet) unmocked.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
  return { unmocked };
}
