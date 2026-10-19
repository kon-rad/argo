import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { addDevice } from '../src/ingest/devices.js';
import { routeDirect, routeState, routeThroughProxy, watchProxy } from '../src/ledger/claudeSettings.js';
import { defaultConfig } from '../src/ledger/config.js';
import { assembleSse, captureQueue, HEALTH_PATH, recordExchange, sessionFromMetadata, startProxy, type Captured } from '../src/ledger/proxy.js';
import { Ledger } from '../src/ledger/store.js';
import { syncOnce } from '../src/ledger/sync.js';
import { truncateAll } from './helpers.js';

const SID = '6f1d2c3b-1111-4a2b-9c3d-123456789abc';
const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const STREAM = sse([
  { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant', usage: { input_tokens: 12, cache_read_input_tokens: 900 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'check the ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'files' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ls"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 33 } },
  { type: 'message_stop' },
]);

const request = (turns: number) => ({
  model: 'claude-opus-5-5', max_tokens: 32000, stream: true, thinking: { type: 'adaptive' },
  metadata: { user_id: JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: SID }) },
  system: [{ type: 'text', text: 'You are Claude Code.' }],
  tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
  messages: Array.from({ length: turns }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` })),
});

describe('assembleSse', () => {
  it('rebuilds the final message from a stream', () => {
    expect(assembleSse(STREAM)).toMatchObject({
      id: 'msg_1', model: 'claude-opus-5-5', stop_reason: 'tool_use',
      content: [{ type: 'thinking', thinking: 'check the files', signature: 'sig' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
      usage: { input_tokens: 12, cache_read_input_tokens: 900, output_tokens: 33 },
    });
  });
  it('reads the session id out of Claude Code metadata', () => {
    expect(sessionFromMetadata(JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: SID }))).toBe(SID);
    expect(sessionFromMetadata(`user_abc_account_x_session_${SID}`)).toBe(SID);
    expect(sessionFromMetadata('nope')).toBeNull();
  });
});

describe('capture proxy', () => {
  let upstream: Server;
  let proxy: Server;
  let root: string;
  let ledger: Ledger;
  let seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }>;
  let proxyUrl: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'ledger-proxy-'));
    ledger = new Ledger(join(root, 'ledger.db'));
    seen = [];
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
        if (req.url?.startsWith('/v1/messages')) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_${seen.length}` });
          res.end(STREAM);
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        }
      });
    });
    await new Promise<void>((ok) => upstream.listen(0, '127.0.0.1', ok));
    const captured: Captured[] = [];
    proxy = await startProxy({
      port: 0, upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      onCapture: (c) => { captured.push(c); recordExchange(ledger, c, 'anthropic'); },
    });
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((ok) => proxy.close(ok));
    await new Promise((ok) => upstream.close(ok));
    ledger.close();
  });

  const send = (turns: number) => fetch(`${proxyUrl}/v1/messages?beta=true`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token', 'accept-encoding': 'gzip' },
    body: JSON.stringify(request(turns)),
  });
  const settle = () => new Promise((ok) => setTimeout(ok, 50));

  it('forwards byte for byte, keeps auth upstream only, and records the exchange', async () => {
    const res = await send(1);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(STREAM);
    await settle();
    expect(seen[0]).toMatchObject({ url: '/v1/messages?beta=true' });
    expect(seen[0]!.headers.authorization).toBe('Bearer secret-token');
    expect(seen[0]!.headers['accept-encoding']).toBeUndefined();

    const ex = ledger.get<Record<string, any>>('exchange', 'anthropic|req_1')!;
    expect(ex).toMatchObject({
      status: 200, requestId: 'req_1', model: 'claude-opus-5-5', sessionExternalId: SID,
      params: { max_tokens: 32000, thinking: { type: 'adaptive' }, stream: true },
      response: { stop_reason: 'tool_use', content: [{ thinking: 'check the files' }, { name: 'Bash', input: { command: 'ls' } }] },
      usage: { output_tokens: 33, cache_read_input_tokens: 900 }, error: null,
    });
    expect(ledger.get<Record<string, any>>('blob', ex.system)!.body).toEqual([{ type: 'text', text: 'You are Claude Code.' }]);
    expect(ledger.get<Record<string, any>>('blob', ex.tools)!.kind).toBe('tools');
    // No header (so no token) anywhere in the ledger.
    const all = ledger.pending(0, 1e9).map((r) => JSON.stringify(r.data)).join('\n');
    expect(all).not.toContain('secret-token');
  });

  it('stores the system prompt, tools and earlier messages once across turns', async () => {
    await send(1);
    await settle();
    const blobsAfterOne = ledger.pending(0, 1e9).filter((r) => r.kind === 'blob').length;
    await send(3);
    await settle();
    const rows = ledger.pending(0, 1e9);
    expect(blobsAfterOne).toBe(3); // system, tools, turn 0
    expect(rows.filter((r) => r.kind === 'blob')).toHaveLength(5); // + turn 1, turn 2
    expect((ledger.get<Record<string, any>>('exchange', 'anthropic|req_2')!.messages as string[])).toHaveLength(3);
  });

  it('passes other endpoints through without recording them, and answers its own health check', async () => {
    expect(await (await fetch(`${proxyUrl}/api/hello`)).json()).toEqual({ ok: true });
    expect((await fetch(`${proxyUrl}${HEALTH_PATH}`)).status).toBe(200);
    await settle();
    expect(ledger.headSeq).toBe(0);
    expect(seen.map((s) => s.url)).toEqual(['/api/hello']); // health never reaches the upstream
  });

  it('cancels the upstream call when the agent hangs up mid-stream', async () => {
    await new Promise((ok) => upstream.close(ok));
    let upstreamClosed = false;
    upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ping\ndata: {}\n\n'); // starts streaming, never finishes
      res.on('close', () => { upstreamClosed = true; });
    });
    await new Promise<void>((ok) => upstream.listen(0, '127.0.0.1', ok));
    await new Promise((ok) => proxy.close(ok));
    proxy = await startProxy({ port: 0, upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, onCapture: () => {} });
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const ctl = new AbortController();
    const res = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST', body: '{}', signal: ctl.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ctl.abort();
    await new Promise((ok) => setTimeout(ok, 200));
    expect(upstreamClosed).toBe(true);
  });

  it('answers 502 in the API error shape when the upstream is down', async () => {
    await new Promise((ok) => upstream.close(ok));
    upstream = http.createServer();
    const res = await send(1);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'api_error' } });
    await new Promise<void>((ok) => upstream.listen(0, '127.0.0.1', ok));
  });

  describe('sync of captured calls', () => {
    let server: Server;
    beforeEach(async () => {
      await truncateAll();
      server = await new Promise<Server>((ok) => { const s = createApp({ modules: new Set(['usage']), deployment: 'local' }).listen(0, '127.0.0.1', () => ok(s)); });
    });
    afterEach(async () => { await new Promise((ok) => server.close(ok)); });
    afterAll(async () => {
      await query(`DELETE FROM llm_exchanges WHERE host='proxy-box'`);
      await query(`DELETE FROM ingest_devices WHERE host='proxy-box'`);
      await query(`DELETE FROM usage_hosts WHERE slug='proxy-box'`);
    });

    it('lands exchanges and content-addressed blobs on the server', async () => {
      const { token } = await addDevice('proxy-box', { display: 'Proxy box', kind: 'laptop' });
      await send(1);
      await send(3);
      await settle();
      const cfg = { ...defaultConfig(root), server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token, hermesHomes: [] };
      expect(await syncOnce(ledger, cfg, { fetch, now: () => new Date(), bundle: 't' }, { force: true })).toMatchObject({ status: 'ok', quarantined: 0 });
      const ex = await query(`SELECT host, request_id, session_external_id, model, cardinality(message_shas) n, usage->>'output_tokens' out
        FROM llm_exchanges ORDER BY request_id`);
      expect(ex.rows).toEqual([
        { host: 'proxy-box', request_id: 'req_1', session_external_id: SID, model: 'claude-opus-5-5', n: 1, out: '33' },
        { host: 'proxy-box', request_id: 'req_2', session_external_id: SID, model: 'claude-opus-5-5', n: 3, out: '33' },
      ]);
      const b = await query(`SELECT kind, count(*)::int n FROM llm_blobs GROUP BY kind ORDER BY kind`);
      expect(b.rows).toEqual([{ kind: 'message', n: 3 }, { kind: 'system', n: 1 }, { kind: 'tools', n: 1 }]);
      // The second request rebuilt from its hashes is the request that was sent.
      const sent = JSON.parse(seen[1]!.body);
      const rebuilt = await query(`SELECT b.body FROM llm_exchanges x, unnest(x.message_shas) WITH ORDINALITY AS m(sha, i)
        JOIN llm_blobs b ON b.sha = m.sha WHERE x.request_id='req_2' ORDER BY m.i`);
      expect(rebuilt.rows.map((r) => r.body)).toEqual(sent.messages);
    });
  });
});

describe('captureQueue', () => {
  it('retries a capture while the ledger is locked and drops one that can never be written', async () => {
    const done: string[] = [];
    let locked = true;
    const log: string[] = [];
    const push = captureQueue((c) => {
      if (c.path === 'bad') throw new Error('not JSON');
      if (locked) throw new Error('database is locked');
      done.push(c.path);
    }, (m) => log.push(m));
    const cap = (path: string) => ({ path } as Captured);
    push(cap('a'));
    push(cap('bad'));
    expect(done).toEqual([]);
    locked = false;
    await new Promise((ok) => setTimeout(ok, 400));
    expect(done).toEqual(['a']);
    expect(log.join(' ')).toContain('dropped');
  });
});

describe('Claude Code routing and fail-open', () => {
  let path: string;
  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), 'claude-settings-')), 'settings.json');
    writeFileSync(path, JSON.stringify({ theme: 'dark', env: { FOO: '1' } }));
  });
  const read = () => JSON.parse(readFileSync(path, 'utf8'));

  it('adds and removes only its own base URL, keeping every other setting', () => {
    expect(routeThroughProxy(18080, path)).toBe('proxy');
    expect(read()).toEqual({ theme: 'dark', env: { FOO: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080' } });
    expect(routeDirect(18080, path)).toBe('direct');
    expect(read()).toEqual({ theme: 'dark', env: { FOO: '1' } });
  });

  it('never touches a gateway someone else configured', () => {
    writeFileSync(path, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example' } }));
    expect(routeThroughProxy(18080, path)).toBe('other');
    expect(routeDirect(18080, path)).toBe('other');
    expect(read().env.ANTHROPIC_BASE_URL).toBe('https://gateway.example');
  });

  it('takes Claude Code off a proxy that failed two checks, and puts it back when healthy', async () => {
    routeThroughProxy(18080, path);
    const down = async () => false;
    const first = await watchProxy(18080, 0, path, down);
    expect(first).toMatchObject({ healthy: false, failures: 1, route: 'proxy', changed: false });
    const second = await watchProxy(18080, first.failures, path, down);
    expect(second).toMatchObject({ failures: 2, route: 'direct', changed: true });
    expect(routeState(18080, path)).toBe('direct');
    const back = await watchProxy(18080, second.failures, path, async () => true);
    expect(back).toMatchObject({ healthy: true, failures: 0, route: 'proxy', changed: true });
  });
});
