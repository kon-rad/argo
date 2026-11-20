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

test('synthetic prospective write, commit and verified gate evidence stay distinct under reverse seek', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: path === '/api/auth/me' ? { required: false, authenticated: true }
      : path === '/api/meta' ? { modules: ['usage', 'observatory'], nav: [], timezone: 'UTC', owner: 'owner', version: 'test' } : {} });
  });
  const t = demoWindow.from;
  await page.goto(`/observatory?demo=1&from=${t}&to=${demoWindow.to}&cursor=${t + 12000}&event=write-call`);
  await expect(page.getByText(/Outcome at cursor: pending/)).toBeVisible();
  await expect(page.getByLabel('Captured change evidence')).toHaveCount(0);
  await page.getByLabel('Replay cursor', { exact: true }).fill(String(t + 12500));
  await page.getByRole('button', { name: /tool_result/ }).last().click();
  await expect(page.getByLabel('Captured change evidence')).toContainText('captured-diff');
  await expect(page.getByLabel('Captured change evidence')).toContainText('notes/demo.md');
  await page.getByLabel('Replay cursor', { exact: true }).fill(String(t + 14000));
  await page.getByRole('button', { name: /tool_result/ }).last().click();
  await expect(page.getByLabel('Captured change evidence')).toContainText('local-object');
  await expect(page.getByLabel('Captured change evidence')).toContainText('unknown');
  await page.getByLabel('Replay cursor', { exact: true }).fill(String(t + 18500));
  await page.getByRole('button', { name: /artifact/ }).last().click();
  await expect(page.getByLabel('PR evidence')).toContainText('merge-verified');
  await expect(page.getByText('No evidenced active executions at this cursor.')).toBeVisible();
  await page.getByLabel('Replay cursor', { exact: true }).fill(String(t + 12000));
  await expect(page.getByLabel('Captured change evidence')).toHaveCount(0);
  await expect(page.getByLabel('PR evidence')).toHaveCount(0);
});

test('records synthetic 500-node/1500-edge seek and frame budgets', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await page.goto('/e2e/observatory-benchmark.html');
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-ready', '0');
  const measurement = await page.evaluate(async () => {
    const raf = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
    const wake = () => document.querySelector('[aria-label="3D execution workspace"]')!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    const seek = (window as unknown as { syntheticSeek: (tick: number) => void }).syntheticSeek;
    // Warm GPU programs and graph internals before sampling.
    for (let i = 1; i <= 10; i++) { seek(i); await raf(); await raf(); }
    const seekMs: number[] = [];
    for (let i = 11; i <= 50; i++) {
      const start = performance.now(); seek(i); await raf(); await raf(); seekMs.push(performance.now() - start);
    }
    const frames: number[] = []; let previous = await raf();
    for (let i = 0; i < 120; i++) { wake(); const now = await raf(); frames.push(now - previous); previous = now; }
    const p95 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1]!;
    const canvas = document.querySelector('canvas')!;
    const gl = canvas.getContext('webgl2');
    return { synthetic: true, nodes: 500, edges: 1500, seekMs, frameIntervalsMs: frames, p95SeekMs: p95(seekMs), rafFps: 1000 * frames.length / frames.reduce((a, b) => a + b, 0),
      browser: navigator.userAgent, renderer: gl?.getParameter(gl.RENDERER), pixelRatio: 1, viewport: { width: innerWidth, height: innerHeight },
      method: '40 synchronous React scene updates plus two animation frames; 120 interaction-awake requestAnimationFrame intervals. Not GPU completion timing or production workload.' };
  });
  await testInfo.attach('synthetic-performance.json', { body: JSON.stringify(measurement, null, 2), contentType: 'application/json' });
  console.log(JSON.stringify(measurement));
  expect(measurement.p95SeekMs, 'p95 seek target <100ms').toBeLessThan(100);
  expect(measurement.rafFps, 'requestAnimationFrame baseline target >=30fps').toBeGreaterThanOrEqual(30);
});
