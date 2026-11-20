import { test, expect } from '@playwright/test';
import { agentSessions } from '../test/fixtures/tables.js';
import { demoWindow } from '../src/routes/observatory/demo.js';

test('synthetic Observatory replay, restoration and recorded-part navigation', async ({ page }) => {
  const from = demoWindow.from, to = demoWindow.to;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = path === '/api/auth/me' ? { required: false, authenticated: true }
      : path === '/api/meta' ? { modules: ['usage', 'observatory'], nav: [{ section: 'Work', label: 'Observatory', path: '/observatory' }], timezone: 'UTC', owner: 'owner', version: 'test' }
      : path === '/api/sources' ? { sources: [] }
      : path === '/api/sync' ? { installed: false }
      : path.startsWith('/api/usage/agent-sessions/') ? { session: { ...agentSessions.sessions[0], id: 12, host: 'lab', source: 'codex', external_id: 'demo-session', title: 'Synthetic recorded detail', display_title: 'Synthetic recorded detail', persona: null }, runs: [], next: null, steps: [{ id: 2, key: '2:call', step: 'tool_call', ts: new Date(from + 2000).toISOString(), text: 'Synthetic recorded tool input', length: 29, truncated: false, toolName: 'read_file', toolCallId: 'call', isError: null, subagent: null, call: null }] }
      : path === '/api/observatory/window' ? { window: demoWindow, total: demoWindow.events.length, next: null, export: 'fixture-export', diagnostics: { synthetic: true } }
      : path === '/api/observatory/coverage' ? { synthetic: true, historicalCompleteness: 'unknown' }
      : path.includes('/api/observatory/events/') ? { event: demoWindow.events.find(e => e.id === 'call'), detail: { availability: 'source-pointer', content: 'not-included' } }
      : {};
    await route.fulfill({ json });
  });
  await page.goto(`/observatory?demo=1&from=${from}&to=${to}&cursor=${from + 2000}&event=call`);
  await expect(page.getByText(/Outcome at cursor: pending/)).toBeVisible();
  await expect(page.getByRole('button', { name: /tool_result/ })).toHaveCount(0);
  await expect(page.getByLabel('Active executions').getByRole('button')).toHaveCount(2);
  await expect(page.getByText(/SYNTHETIC DEMO/)).toBeVisible();
  // A real canvas must be present for rendered acceptance; a fallback is not a rendering pass.
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.getByRole('button', { name: 'Next event', exact: true }).click();
  await expect(page.getByRole('button', { name: /tool_result/ })).toBeVisible();
  await page.getByLabel('Replay cursor', { exact: true }).fill(String(from + 5000));
  await expect(page.getByLabel('Active executions').getByRole('button')).toHaveCount(1);
  await page.getByLabel('Replay cursor', { exact: true }).fill(String(from + 7000));
  await expect(page.getByText('No evidenced active executions at this cursor.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Replay cursor', { exact: true })).toHaveValue(String(from + 7000));
  await page.getByLabel('Replay cursor', { exact: true }).fill(String(from + 12000));
  await expect(page.getByLabel('Active executions').getByRole('button')).toHaveCount(1);
  await page.getByLabel('Replay cursor', { exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByLabel('Replay cursor', { exact: true })).toHaveValue(String(from + 11999));
  // Mocked source mode checks the lazy authorized pointer link, without requesting transcript bodies.
  await page.goto(`/observatory?from=${from}&to=${to}&cursor=${from + 2000}&event=call`);
  await page.getByRole('button', { name: 'Verify source detail' }).click();
  await expect(page.getByRole('link', { name: 'Open recorded session part' })).toHaveAttribute('href', '/usage/session/lab/demo-session?source=codex&part=2%3Acall');
  await page.screenshot({ path: 'e2e/test-results/observatory-workspace.png', fullPage: true });
  await page.getByRole('link', { name: 'Open recorded session part' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic recorded detail' })).toBeVisible();
  await expect(page.locator('[id="step-2:call"]')).toHaveCount(1);
  await expect(page).toHaveURL(/part=2%3Acall/);
});

// Coordinator-only rendered scenario. API fixtures do not establish source permissions or production coverage.
test('Brain Map exact note overlay, unresolved evidence and shared replay navigation', async ({ page }) => {
  const { mapGraph, mapWindow } = await import('../test/fixtures/observatoryMap.js');
  const from = mapWindow.from, to = mapWindow.to;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const json = path === '/api/auth/me' ? { required: false, authenticated: true }
      : path === '/api/meta' ? { modules: ['usage', 'map', 'observatory'], nav: [], timezone: 'UTC', owner: 'owner', version: 'test' }
      : path === '/api/sources' ? { sources: [] }
      : path === '/api/sync' ? { installed: false }
      : path === '/api/map/graph' ? mapGraph
      : path === '/api/observatory/window' ? { window: mapWindow, total: mapWindow.events.length, next: null, export: 'map-fixture', diagnostics: { synthetic: true, historicalCompleteness: 'unknown' } }
      : {};
    if (path === '/api/map/graph' && url.searchParams.has('version')) expect(url.searchParams.get('version')).toBe('7');
    await route.fulfill({ json });
  });
  await page.goto(`/map?activity=1&from=${from}&to=${to}&cursor=${from + 2000}&event=read`);
  await expect(page.getByText(/Current topology is context only/)).toBeVisible();
  await expect(page.getByText(/Unresolved: missing, moved, deleted/)).toBeVisible();
  await expect(page.getByText(/Repository\/path target/)).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect(page).toHaveURL(/layout=7/);
  // Inspect the rendered cyan circle and amber triangle at the existing note, then save evidence.
  await page.screenshot({ path: 'e2e/test-results/observatory-map-overlay.png', fullPage: true });
  await page.getByLabel('Active executions').getByRole('button', { name: /run:lab:parallel/ }).click();
  await expect(page.getByLabel('Note activity').getByRole('button', { name: /▲ W write attempt/ })).toBeVisible();
  await expect(page.getByLabel('Note activity').getByRole('button', { name: /○ R read attempt/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Filter note Projects/demo.md', exact: true }).click();
  await expect(page.getByText('Note activity filter: Projects/demo.md', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Workspace replay', exact: true }).click();
  await expect(page).toHaveURL(/observatory\?/);
  await expect(page.getByLabel('Replay cursor', { exact: true })).toHaveValue(String(from + 2000));
  await expect(page).toHaveURL(/event=run%3Alab%3Aparallel/);
  await expect(page).toHaveURL(/note=Projects%2Fdemo.md/);
  await page.getByRole('link', { name: 'Brain Map replay', exact: true }).click();
  await expect(page.getByText(/Current topology is context only/)).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Replay cursor', { exact: true })).toHaveValue(String(from + 2000));
  await page.getByLabel('Replay cursor', { exact: true }).fill(String(from + 7000));
  await expect(page.getByText('No evidenced active executions at this cursor.')).toBeVisible();
  // Historical operation evidence may remain on the map; ended executions must not remain active.
  await expect(page.getByText(/Current topology is context only/)).toBeVisible();
});
