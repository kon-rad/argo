import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { Redactor } from '../archive/redact.js';
import type { Ledger } from './store.js';

/**
 * The capture proxy: Claude Code's ANTHROPIC_BASE_URL points at it, it forwards every
 * request to the real API unchanged and streams the answer straight back, keeping a
 * copy of each Messages call. Headers are forwarded, never recorded (they carry the
 * token). Recording happens after the response has gone back, and a recording failure
 * is logged, never surfaced: the agent must not notice the proxy.
 */
export interface Captured {
  ts: string; method: string; path: string; status: number; durationMs: number;
  requestId: string | null; contentType: string; requestBody: Buffer; responseBody: Buffer; truncated: boolean;
}
export interface ProxyOpts {
  port: number; upstream: string; bind?: string;
  onCapture: (c: Captured) => void; log?: (msg: string) => void;
}

export const HEALTH_PATH = '/__ledger/health';
const MAX_TEE = 32 * 1024 * 1024; // a response bigger than this is still forwarded whole, just not recorded whole
const MAX_REQUEST = 64 * 1024 * 1024;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'upgrade', 'transfer-encoding']);
const endToEnd = (h: http.IncomingHttpHeaders): http.OutgoingHttpHeaders => {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) if (!HOP.has(k) && v !== undefined) out[k] = v;
  return out;
};
const recordable = (method: string, path: string): boolean => method === 'POST' && /^\/v1\/messages(\?|$)/.test(path);

export function startProxy(opts: ProxyOpts): Promise<http.Server> {
  const up = new URL(opts.upstream);
  const client = up.protocol === 'http:' ? http : https;
  const server = http.createServer((req, res) => {
    if (req.url === HEALTH_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    const started = Date.now();
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (c: Buffer) => {
      received += c.length;
      if (received > MAX_REQUEST) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'request_too_large', message: 'ledger proxy: request body over 64 MB' } }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const body = Buffer.concat(chunks);
      const headers = endToEnd(req.headers);
      headers.host = up.host;
      // Plain responses so the copy is readable; the bytes to the agent are the same content.
      delete headers['accept-encoding'];
      const path = `${up.pathname.replace(/\/$/, '')}${req.url ?? '/'}`;
      const upstream = client.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, method: req.method, path, headers }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, endToEnd(ur.headers));
        const keep = recordable(req.method ?? '', req.url ?? '');
        const tee: Buffer[] = [];
        let size = 0;
        let truncated = false;
        if (keep) {
          ur.on('data', (c: Buffer) => {
            if (size + c.length <= MAX_TEE) { tee.push(c); size += c.length; } else truncated = true;
          });
        }
        ur.pipe(res); // backpressure: a slow reader slows the upstream read, not memory
        ur.on('end', () => {
          if (!keep) return;
          setImmediate(() => {
            try {
              const rid = ur.headers['request-id'];
              opts.onCapture({
                ts: new Date(started).toISOString(), method: req.method ?? 'POST', path: req.url ?? '', status: ur.statusCode ?? 0,
                durationMs: Date.now() - started, requestId: typeof rid === 'string' ? rid : null,
                contentType: String(ur.headers['content-type'] ?? ''), requestBody: body, responseBody: Buffer.concat(tee), truncated,
              });
            } catch (err) {
              opts.log?.(`capture failed (request still served): ${(err as Error).message}`);
            }
          });
        });
        ur.on('error', () => res.destroy());
      });
      // The agent hung up (Esc, a crash): stop the upstream call so the model stops generating and billing.
      res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
      upstream.on('error', (err) => {
        if (res.destroyed) return;
        opts.log?.(`upstream error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `ledger proxy: upstream unreachable: ${err.message}` } }));
      });
      upstream.end(body);
    });
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port, opts.bind ?? '127.0.0.1', () => ok(server));
  });
}

/** The final message an Anthropic SSE stream describes: content blocks, stop reason and usage. */
export function assembleSse(text: string): Record<string, any> {
  let msg: Record<string, any> = { content: [] };
  const partial = new Map<number, string>();
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    let ev: any;
    try { ev = JSON.parse(data); } catch { continue; }
    switch (ev?.type) {
      case 'message_start': msg = { ...ev.message, content: [] }; break;
      case 'content_block_start': msg.content[ev.index] = { ...ev.content_block }; break;
      case 'content_block_delta': {
        const b = msg.content[ev.index] ?? (msg.content[ev.index] = {});
        const d = ev.delta ?? {};
        if (d.type === 'text_delta') b.text = (b.text ?? '') + d.text;
        else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
        else if (d.type === 'signature_delta') b.signature = d.signature;
        else if (d.type === 'input_json_delta') partial.set(ev.index, (partial.get(ev.index) ?? '') + d.partial_json);
        break;
      }
      case 'content_block_stop': {
        const json = partial.get(ev.index);
        if (json !== undefined) {
          try { msg.content[ev.index].input = json ? JSON.parse(json) : {}; } catch { msg.content[ev.index].input_raw = json; }
          partial.delete(ev.index);
        }
        break;
      }
      case 'message_delta':
        if (ev.delta?.stop_reason !== undefined) msg.stop_reason = ev.delta.stop_reason;
        if (ev.delta?.stop_sequence !== undefined) msg.stop_sequence = ev.delta.stop_sequence;
        if (ev.usage) msg.usage = { ...(msg.usage ?? {}), ...ev.usage };
        break;
      case 'error': msg.error = ev.error; break;
    }
  }
  return msg;
}

export const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/**
 * The transcript's session id from Claude Code's metadata.user_id: a JSON string with a
 * `session_id` field (seen 2026-10), or older `..._session_<uuid>` text.
 */
export function sessionFromMetadata(userId: unknown): string | null {
  if (typeof userId !== 'string') return null;
  try {
    const sid = (JSON.parse(userId) as { session_id?: unknown })?.session_id;
    if (typeof sid === 'string' && sid) return sid;
  } catch { /* not JSON */ }
  const m = /session_([0-9a-f-]{36})/i.exec(userId);
  return m ? m[1]! : null;
}

/**
 * One captured call into the ledger. The system prompt, the tool list and every message
 * are stored once as content-addressed blobs; the exchange lists their hashes. Each turn
 * re-sends the whole conversation, so storing it whole would grow with the square of its length.
 */
/**
 * `red` removes this machine's keys before anything is hashed: blobs are stored and sent by content hash,
 * so they can't be redacted later without breaking the exchanges that point at them.
 */
export function recordExchange(ledger: Ledger, c: Captured, provider: string, red: Redactor): void {
  let req: Record<string, any> | null = null;
  try { req = red.deep(JSON.parse(c.requestBody.toString('utf8'))); } catch { /* not JSON: kept as an error note below */ }
  const text = red.text(c.responseBody.toString('utf8'));
  let response: Record<string, any> | null = null;
  if (!c.truncated) {
    if (c.contentType.includes('text/event-stream')) response = assembleSse(text);
    else { try { response = JSON.parse(text); } catch { response = null; } }
  }
  const sid = sessionFromMetadata(req?.metadata?.user_id);
  const sessionKey = sid ? `claude-code|${sid}` : null;
  ledger.tx(() => {
    // ts = first seen: a blob already stored keeps its first time (an unchanged put is a no-op), which prune reads.
    const blob = (kind: string, body: unknown): string | null => {
      if (body === undefined) return null;
      const h = sha(body);
      ledger.put('blob', h, { sha: h, kind, body }, { source: provider, ts: c.ts });
      return h;
    };
    const { system, tools, messages, ...params } = req ?? {};
    const messageShas = Array.isArray(messages) ? messages.map((m: unknown) => blob('message', m ?? null)!) : [];
    ledger.put('exchange', `${provider}|${c.requestId ?? randomUUID()}`, {
      ts: c.ts, provider, method: c.method, path: c.path, status: c.status, durationMs: c.durationMs, requestId: c.requestId,
      sessionExternalId: sid, model: req?.model ?? null, params: req ? params : null,
      system: blob('system', system), tools: blob('tools', tools), messages: messageShas,
      response: response ? { ...response, content: response.content ?? null } : null,
      usage: response?.usage ?? null,
      error: c.status >= 400 || !req || c.truncated ? (c.truncated ? 'response larger than the capture limit' : text.slice(0, 10_000)) : null,
    }, { source: provider, sessionKey, ts: c.ts });
  });
}

/**
 * Records captures one at a time, off the request path. The scheduled run may hold the
 * ledger's write lock for a moment; the proxy's handle has a short busy timeout, so a
 * locked write fails fast and is retried here instead of stalling live streams.
 */
export function captureQueue(record: (c: Captured) => void, log?: (msg: string) => void, max = 500): (c: Captured) => void {
  const queue: Captured[] = [];
  let timer: NodeJS.Timeout | null = null;
  const drain = (): void => {
    timer = null;
    while (queue.length) {
      try {
        record(queue[0]!);
        queue.shift();
      } catch (err) {
        const msg = (err as Error).message;
        if (/locked|busy/i.test(msg)) { timer = setTimeout(drain, 250); return; }
        log?.(`capture dropped (request was served): ${msg}`);
        queue.shift();
      }
    }
  };
  return (c) => {
    if (queue.length >= max) { queue.shift(); log?.('capture queue full: dropped the oldest capture'); }
    queue.push(c);
    if (!timer) drain();
  };
}

/**
 * Redacts captures recorded before the proxy redacted (or with fewer env files), in place. Only rows not yet
 * acknowledged by the server: each blob whose body changes gets its new hash, the exchanges are repointed,
 * and blobs no unsent exchange or acknowledged row needs any more are deleted.
 */
export function redactCaptures(ledger: Ledger, red: Redactor): { exchanges: number; blobs: number; removed: number } {
  const acked = ledger.syncState().ackedSeq;
  const keys = (ledger.db.prepare(`SELECT key FROM records WHERE kind='exchange' AND seq > ?`).all(acked) as Array<{ key: string }>).map((r) => r.key);
  const out = { exchanges: 0, blobs: 0, removed: 0 };
  const renamed = new Map<string, string>();
  const swap = (h: unknown): unknown => {
    if (typeof h !== 'string') return h;
    if (renamed.has(h)) return renamed.get(h);
    const blob = ledger.get<{ sha: string; kind: string; body: unknown }>('blob', h);
    if (!blob) return h;
    const body = red.deep(blob.body);
    const nh = sha(body);
    if (nh !== h) { ledger.put('blob', nh, { sha: nh, kind: blob.kind, body }, { source: 'anthropic' }); out.blobs++; }
    renamed.set(h, nh);
    return nh;
  };
  for (const key of keys) {
    ledger.tx(() => {
      const x = ledger.get<Record<string, unknown>>('exchange', key);
      if (!x) return;
      const { system, tools, messages, ...rest } = x;
      const next = { ...red.deep(rest), system: swap(system), tools: swap(tools), messages: Array.isArray(messages) ? messages.map(swap) : messages };
      const row = ledger.db.prepare(`SELECT source, session_key, ts FROM records WHERE kind='exchange' AND key=?`).get(key) as { source: string | null; session_key: string | null; ts: string | null };
      if (ledger.put('exchange', key, next, { source: row.source ?? undefined, sessionKey: row.session_key ?? undefined, ts: row.ts ?? undefined })) out.exchanges++;
    });
  }
  // Blobs still referenced by any exchange stay; so does anything the server already has.
  const used = new Set<string>();
  for (const r of ledger.db.prepare(`SELECT key FROM records WHERE kind='exchange'`).all() as Array<{ key: string }>) {
    const x = ledger.get<{ system?: string | null; tools?: string | null; messages?: string[] }>('exchange', r.key);
    if (!x) continue;
    for (const h of [x.system, x.tools, ...(x.messages ?? [])]) if (h) used.add(h);
  }
  const stale = (ledger.db.prepare(`SELECT key FROM records WHERE kind='blob' AND seq > ?`).all(acked) as Array<{ key: string }>)
    .map((r) => r.key).filter((k) => !used.has(k));
  const del = ledger.db.prepare(`DELETE FROM records WHERE kind='blob' AND key=?`);
  ledger.tx(() => { for (const k of stale) del.run(k); });
  out.removed = stale.length;
  return out;
}
