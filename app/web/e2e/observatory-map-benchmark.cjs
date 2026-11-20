#!/usr/bin/env node
'use strict';

/**
 * Install this file at app/web/e2e/observatory-map-benchmark.cjs.
 * Requires an existing production build and the repository's Playwright dependency.
 * This starts Vite preview; it never builds or changes application source.
 *
 * OBSERVATORY_CHROME: optional installed browser executable (otherwise bundled Chromium)
 * OBSERVATORY_BENCH_PORT: loopback preview port, default 5206
 * OBSERVATORY_BENCH_OUTPUT: output directory, otherwise a fresh OS temporary directory
 * OBSERVATORY_BENCH_CYCLES: map/workspace roundtrips, default 30 (120 is supported)
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const webRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(webRoot, '..', '..');
const { chromium } = require(require.resolve('playwright', { paths: [webRoot] }));
const port = positiveInteger(process.env.OBSERVATORY_BENCH_PORT, 5206, 65535);
const cycles = positiveInteger(process.env.OBSERVATORY_BENCH_CYCLES, 30, 300);
const output = process.env.OBSERVATORY_BENCH_OUTPUT
  ? path.resolve(process.env.OBSERVATORY_BENCH_OUTPUT)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'observatory-map-benchmark-'));
const origin = `http://127.0.0.1:${port}`;
const from = Date.parse('2026-01-01T00:00:00Z');
fs.mkdirSync(output, { recursive: true });

function positiveInteger(raw, fallback, maximum) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Expected an integer between 1 and ${maximum}, received ${raw}`);
  }
  return value;
}
function git(...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}
function revision() {
  return {
    head: git('rev-parse', 'HEAD'),
    webTree: git('rev-parse', 'HEAD:app/web'),
    trackedChanges: git('status', '--porcelain', '--untracked-files=no'),
  };
}
function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function writeJSON(name, data) {
  fs.writeFileSync(path.join(output, name), JSON.stringify(data, null, 2) + '\n');
}
function percentile(samples, fraction) {
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1];
}
function syntheticFixture() {
  const graph = {
    version: 77,
    builtAt: '2026-01-01T00:00:00Z',
    nodes: Array.from({ length: 500 }, (_, i) => ({
      id: `note:${i}`, kind: 'note', ref: `Projects/synthetic-${i}.md`,
      label: `Synthetic ${i}`, parent: null, color: null, size: 1,
      x: (i % 25) * 24, y: Math.floor(i / 25) * 24, z: (i % 3) * 20, meta: {},
    })),
    edges: Array.from({ length: 1500 }, (_, i) => ({
      source: `note:${i % 500}`,
      target: `note:${(i + 1 + Math.floor(i / 500)) % 500}`,
      kind: 'link',
    })),
  };
  const events = Array.from({ length: 5000 }, (_, i) => ({
    version: 1, id: `event:${i}`, at: from + i * 3, observedAt: null,
    sequence: i, part: 0, kind: 'tool_call', session: 'archive:12',
    execution: 'run:synthetic:one',
    context: { host: 'synthetic', runtime: 'codex', source: 'codex', externalSession: 'fixture' },
    actor: { kind: 'agent', sender: null, channel: 'synthetic', evidence: 'synthetic fixture' },
    source: { table: 'archive_messages', id: String(i + 1), part: `${i}:call` },
    precision: 'millisecond', confidence: 'recorded',
    tool: i % 2 ? 'write_file' : 'read_file', occurrence: `event:${i}`,
    target: {
      path: `/srv/vault/Projects/synthetic-${i % 500}.md`,
      vaultPath: `Projects/synthetic-${i % 500}.md`, operation: i % 2 ? 'write' : 'read',
    },
  }));
  const window = {
    version: 1, from, to: from + 20000, boundary: { tickets: {}, tools: {} },
    intervals: [{
      id: 'run:synthetic:one', session: 'archive:12', start: from, end: from + 20000,
      host: 'synthetic', runtime: 'codex', persona: 'fixture', ticket: null, evidence: 'usage_runs',
    }],
    events,
  };
  return { graph, window, events };
}
async function waitForPreview(child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Preview exited with ${child.exitCode}`);
    try {
      if ((await fetch(origin)).ok) return;
    } catch { /* The fresh preview may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Preview did not become ready within ten seconds');
}

// Inspect only the mounted library reference from the test. No app debug API is added.
async function rendererSnapshot(page) {
  return page.evaluate(() => {
    let element = document.querySelector('canvas')?.parentElement;
    let resources;
    for (let parent = 0; element && !resources && parent < 30; parent++) {
      const key = Object.keys(element).find(name => name.startsWith('__reactFiber'));
      let fiber = element[key];
      for (let depth = 0; fiber && !resources && depth < 100; depth++) {
        let hook = fiber.memoizedState;
        for (let index = 0; hook && index < 100; index++) {
          const graph = hook.memoizedState?.current;
          if (graph?.renderer && graph?.graphData) {
            const renderer = graph.renderer();
            resources = {
              memory: { ...renderer.info.memory }, programs: renderer.info.programs?.length,
              graphNodes: graph.graphData().nodes.length, graphLinks: graph.graphData().links.length,
            };
            break;
          }
          hook = hook.next;
        }
        fiber = fiber.return;
      }
      element = element.parentElement;
    }
    return {
      ...resources,
      canvasCount: document.querySelectorAll('canvas').length,
      noteRows: document.querySelector('[aria-label="Note activity"]')?.children.length,
      activitySummary: [...document.querySelectorAll('p')].find(p => p.textContent.includes('evidenced path operations'))?.textContent,
      drawCalls: window.__observatoryBenchmarkDrawCalls,
    };
  });
}
async function measureSeeks(page) {
  return page.evaluate(async startTime => {
    const slider = document.querySelector('[aria-label="Replay cursor"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const totalMs = [], domMs = [], nextFrameMs = [];
    for (let iteration = 0; iteration < 100; iteration++) {
      const offset = iteration % 2 ? 14997 : 7497;
      const expectedEvents = iteration % 2 ? 5000 : 2500;
      const start = performance.now();
      setter.call(slider, String(startTime + offset));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve, reject) => {
        const list = document.querySelector('[aria-label="Note activity"]');
        const done = () => list.children.length === 200 && list.firstElementChild.textContent
          .includes(`archive_messages:${expectedEvents - 199} part`);
        if (done()) return resolve();
        const observer = new MutationObserver(() => {
          if (done()) { observer.disconnect(); clearTimeout(timer); resolve(); }
        });
        observer.observe(list, { childList: true, subtree: true });
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Seek timed out')); }, 15000);
      });
      const dom = performance.now() - start;
      domMs.push(dom);
      await new Promise(resolve => requestAnimationFrame(resolve));
      const total = performance.now() - start;
      totalMs.push(total); nextFrameMs.push(total - dom);
    }
    return { totalMs, domMs, nextFrameMs };
  }, from);
}
async function measureFrames(page) {
  return page.evaluate(async () => {
    const intervals = [];
    let previous = await new Promise(resolve => requestAnimationFrame(resolve));
    for (let sample = 0; sample < 120; sample++) {
      document.querySelector('canvas').dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
      const current = await new Promise(resolve => requestAnimationFrame(resolve));
      intervals.push(current - previous); previous = current;
    }
    return intervals;
  });
}
function markdown(report) {
  const assets = report.servedAssets.map(asset =>
    `| ${asset.asset} | ${asset.sha256} | ${asset.matchesDist} |`).join('\n');
  const heaps = report.modeCycles.map(sample =>
    `| ${sample.cycle} | ${sample.heap.usedSize} | ${sample.resources.canvasCount} |`).join('\n');
  return `# Synthetic production Brain Map benchmark

Source before: ${report.before.head}
Source after: ${report.after.head}
App/web tree before: ${report.before.webTree}
App/web tree after: ${report.after.webTree}
Mode: existing production build served by Vite preview. No build is performed.
Browser: ${report.device.userAgent}
Renderer: ${report.device.renderer}
Viewport: ${report.device.viewport.width}x${report.device.viewport.height}

| Check | Actual result |
|---|---|
| Workload | 500 map nodes, 1500 edges, 5000 synthetic events over ten pages |
| Actual UI seeks | 100 alternating forward/backward inputs |
| Seek p50 / p95 / max | ${percentile(report.seeks.totalMs, .5).toFixed(1)} / ${percentile(report.seeks.totalMs, .95).toFixed(1)} / ${Math.max(...report.seeks.totalMs).toFixed(1)} ms |
| DOM completion p95 | ${percentile(report.seeks.domMs, .95).toFixed(1)} ms |
| Awake RAF cadence | ${report.rafFps.toFixed(2)} fps |
| Idle native draw-call increase | ${report.idle.drawCallDelta} over 1500 ms |
| Mode roundtrips | ${report.modeCycles.length} |
| Forced-GC JS heap baseline / final | ${report.baselineHeap.usedSize} / ${report.finalHeap.usedSize} bytes |
| Retained heap difference | ${report.finalHeap.usedSize - report.baselineHeap.usedSize} bytes |
| JS errors | ${report.errors.length} |

These samples include real map route derivation, HTML updates and overlay rendering. They are not isolated Workspace renderer measurements or production data. RAF measures scheduling, not GPU completion. The 32 MiB serialized metadata budget is not a browser heap ceiling. Resource counts describe only the currently mounted context, not all GPU memory or leaked contexts. A finite GC series and stable live counts do not establish a flat plateau or prove no leak. Inspect all cycle samples and record competing host workloads before drawing conclusions.

The committed web tree identifies source; served hashes attest bytes match existing dist files. This script alone does not prove that dist was built from that source tree. Pair this receipt with an exact-source build receipt. Raw timings, device, transport offsets, heap/resource samples and hashes are in results.json. No personal data or credentials are requested.

## Served JavaScript attestation

| Asset | Served SHA-256 | Matches existing dist |
|---|---|---|
${assets}

## Forced-GC cycle samples

| Cycle | JS used bytes | Live canvases |
|---|---|---|
${heaps}
`;
}

async function main() {
  const before = revision();
  if (before.trackedChanges) throw new Error('Tracked source changes exist; commit before measuring');
  if (!fs.existsSync(path.join(webRoot, 'dist', 'index.html'))) throw new Error('Existing production build is required');
  const viteRoot = path.dirname(require.resolve('vite/package.json', { paths: [webRoot] }));
  const previewLog = fs.openSync(path.join(output, 'preview.log'), 'w');
  const preview = spawn(process.execPath, [path.join(viteRoot, 'bin', 'vite.js'), 'preview',
    '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: webRoot, stdio: ['ignore', previewLog, previewLog] });
  let browser;
  try {
    await waitForPreview(preview);
    const executablePath = process.env.OBSERVATORY_CHROME;
    browser = await chromium.launch({
      headless: true, ...(executablePath ? { executablePath } : {}),
      args: process.platform === 'darwin' && executablePath
        ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : [],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: 'UTC' });
    const fixture = syntheticFixture(), errors = [], offsets = [], servedAssets = [], assetReads = [];
    let apiBytes = 0;
    page.on('pageerror', error => errors.push(String(error)));
    page.on('response', response => {
      const asset = new URL(response.url()).pathname;
      if (!asset.endsWith('.js')) return;
      assetReads.push(response.body().then(body => {
        const local = path.join(webRoot, 'dist', asset.replace(/^\//, ''));
        servedAssets.push({ asset, sha256: digest(body), bytes: body.length,
          matchesDist: fs.existsSync(local) && digest(fs.readFileSync(local)) === digest(body) });
      }));
    });
    await page.addInitScript(() => {
      window.__observatoryBenchmarkDrawCalls = 0;
      // Instrument each own native draw method once; no application debug API is installed.
      for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
        for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
          if (!Object.hasOwn(prototype, name)) continue;
          const original = prototype[name];
          prototype[name] = function (...args) {
            window.__observatoryBenchmarkDrawCalls++;
            return original.apply(this, args);
          };
        }
      }
    });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const endpoint = url.pathname;
      let json = {};
      if (endpoint === '/api/auth/me') json = { required: false, authenticated: true };
      else if (endpoint === '/api/meta') json = {
        modules: ['map', 'observatory', 'usage'], nav: [], timezone: 'UTC', owner: 'owner', version: 'synthetic-benchmark',
      };
      else if (endpoint === '/api/sources') json = { sources: [] };
      else if (endpoint === '/api/sync') json = { installed: false };
      else if (endpoint === '/api/map/graph') json = fixture.graph;
      else if (endpoint === '/api/observatory/window') {
        const offset = Number(url.searchParams.get('offset') || 0);
        offsets.push(offset);
        json = {
          window: { ...fixture.window, events: fixture.events.slice(offset, offset + 500) },
          total: 5000, next: offset + 500 < 5000 ? offset + 500 : null,
          export: 'synthetic-map-benchmark', diagnostics: { synthetic: true },
        };
      } else if (endpoint === '/api/observatory/coverage') json = { synthetic: true };
      const body = JSON.stringify(json); apiBytes += Buffer.byteLength(body);
      await route.fulfill({ contentType: 'application/json', body });
    });
    await page.goto(`${origin}/map?activity=1&layout=77&from=${from}&to=${from + 20000}&cursor=${from + 14997}`);
    await page.locator('canvas').waitFor();
    await page.getByLabel('Note activity').getByRole('button').last().waitFor();
    await page.waitForTimeout(1800);
    const initial = await rendererSnapshot(page);
    const expectedOffsets = Array.from({ length: 10 }, (_, index) => index * 500);
    if (JSON.stringify([...new Set(offsets)].sort((a, b) => a - b)) !== JSON.stringify(expectedOffsets)
      || initial.noteRows !== 200 || !initial.activitySummary?.startsWith('5000 ')
      || initial.graphNodes !== 500 || initial.graphLinks !== 1500) {
      throw new Error('Incomplete or unexpected map fixture; no benchmark claim is valid');
    }
    const device = await page.evaluate(() => {
      const gl = document.querySelector('canvas').getContext('webgl2');
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        userAgent: navigator.userAgent,
        renderer: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
        viewport: { width: innerWidth, height: innerHeight }, hardwareConcurrency: navigator.hardwareConcurrency,
      };
    });
    const seeks = await measureSeeks(page);
    writeJSON('seeks-interim.json', { before, device, seeks });
    console.log(`100 actual map seeks: p95 ${percentile(seeks.totalMs, .95).toFixed(1)} ms`);
    const frameIntervalsMs = await measureFrames(page);
    await page.waitForTimeout(2000);
    const idleBefore = await rendererSnapshot(page);
    await page.waitForTimeout(1500);
    const idleAfter = await rendererSnapshot(page);
    const cdp = await page.context().newCDPSession(page);
    async function heapAfterGC() {
      await cdp.send('HeapProfiler.collectGarbage');
      return cdp.send('Runtime.getHeapUsage');
    }
    const baselineHeap = await heapAfterGC(), modeCycles = [];
    for (let cycle = 1; cycle <= cycles; cycle++) {
      await page.getByRole('link', { name: 'Workspace replay', exact: true }).click();
      await page.getByLabel('3D execution workspace').waitFor();
      await page.locator('canvas').waitFor();
      await page.getByRole('link', { name: 'Brain Map replay', exact: true }).click();
      await page.getByLabel('Brain Map activity').waitFor();
      await page.locator('canvas').waitFor();
      await page.waitForTimeout(100);
      modeCycles.push({ cycle, heap: await heapAfterGC(), resources: await rendererSnapshot(page) });
      writeJSON('cycles-interim.json', modeCycles);
      if (cycle % 5 === 0) console.log(`Mode roundtrips: ${cycle}/${cycles}`);
    }
    await page.waitForTimeout(2000);
    const finalHeap = await heapAfterGC();
    await Promise.all(assetReads);
    const after = revision();
    const report = {
      before, after, mode: 'built-production-vite-preview', device, servedAssets,
      fixture: { nodes: 500, edges: 1500, events: 5000, apiBytes, offsets,
        serializedBytes: Buffer.byteLength(JSON.stringify({ graph: fixture.graph, window: fixture.window })) },
      initial, seeks, frameIntervalsMs,
      rafFps: frameIntervalsMs.length * 1000 / frameIntervalsMs.reduce((sum, value) => sum + value, 0),
      idle: { durationMs: 1500, before: idleBefore, after: idleAfter,
        drawCallDelta: idleAfter.drawCalls - idleBefore.drawCalls },
      baselineHeap, modeCycles, finalHeap, errors,
    };
    writeJSON('results.json', report);
    fs.writeFileSync(path.join(output, 'receipt.md'), markdown(report));
    await page.screenshot({ path: path.join(output, 'map.png') });
    if (before.head !== after.head || before.webTree !== after.webTree || after.trackedChanges) {
      throw new Error('Source changed during measurement; results are provisional');
    }
    if (!servedAssets.length || servedAssets.some(asset => !asset.matchesDist)) throw new Error('Served asset/dist hash mismatch');
    if (errors.length) throw new Error('Application JavaScript errors occurred; inspect results.json');
    // Raw measurements remain available when a baseline target is unmet.
    if (percentile(seeks.totalMs, .95) >= 100 || report.rafFps < 30) {
      throw new Error('Measured timing target unmet; inspect receipt and raw samples');
    }
    console.log(`Receipt and raw samples: ${output}`);
  } finally {
    if (browser) await browser.close();
    preview.kill('SIGTERM');
    fs.closeSync(previewLog);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
