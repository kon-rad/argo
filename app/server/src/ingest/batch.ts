import { createHash } from 'node:crypto';
import { z } from 'zod';
import { clean } from '../archive/clean.js';
import { withTransaction } from '../db.js';
import * as archive from '../archive/store.js';
import type { ParsedMessage, SessionInput } from '../archive/types.js';
import * as usage from '../usage/store.js';
import type { HermesCounters, UsageCall } from '../usage/types.js';
import type { IngestResponse, WireBatch } from '../ledger/types.js';

/**
 * One ledger batch into the archive and usage tables, in one transaction, as the
 * device's host. Every write is the same idempotent upsert the other collectors use,
 * so a resent batch changes nothing, and rows may arrive in any order. Shape errors are BatchError (the route answers
 * 422 and the ledger isolates the row); database trouble propagates (5xx, retried).
 */
export class BatchError extends Error {}

const str = z.string().max(100_000);
const opt = <T extends z.ZodType>(t: T) => t.nullish().transform((v) => v ?? null);
const num = z.number().finite();
const source = z.string().regex(/^[a-z][a-z0-9-]{0,31}(:[A-Za-z0-9_.-]{1,64})?$/);

const sessionData = z.object({
  source, externalId: str, parentExternalId: opt(str), project: opt(str), title: opt(str), model: opt(str),
  startedAt: opt(z.string()), endedAt: opt(z.string()), messageCount: opt(num), inputTokens: opt(num),
  outputTokens: opt(num), costUsd: opt(num), meta: z.record(z.string(), z.unknown()).nullish(), provider: opt(str),
});
const messageData = z.object({
  sessionExternalId: str, seq: num, externalId: str, parentExternalId: opt(str), role: str, kind: str,
  ts: opt(z.string()), contentText: z.string(), raw: z.unknown(), rawSha: z.string().max(128), isSidechain: z.boolean(),
});
const callData = z.object({
  source, callId: str, requestId: opt(str), sessionExternalId: str, messageExternalId: opt(str), ts: z.string(),
  model: str, entrypoint: opt(str), cwd: opt(str), isSidechain: z.boolean(), inputTokens: num, cacheWriteTokens: num,
  cacheReadTokens: num, outputTokens: num, thinkingTokens: num, webSearchRequests: num, tool: opt(str),
  action: opt(z.enum(['dm', 'post', 'ticket', 'card', 'tracker', 'write', 'read', 'shell', 'reply'])), provider: opt(str),
  matchKey: opt(str),
});
const counterData = z.object({
  profile: str, sessionId: str, model: opt(str), billingProvider: opt(str), startedAt: opt(z.string()), endedAt: opt(z.string()),
  inputTokens: num, outputTokens: num, cacheReadTokens: num, cacheWriteTokens: num, reasoningTokens: num, apiCalls: num, costUsd: opt(num),
});

const hex = z.string().regex(/^[0-9a-f]{64}$/);
const blobData = z.object({ sha: hex, kind: z.enum(['system', 'tools', 'message']), body: z.unknown() });
const exchangeData = z.object({
  ts: z.string(), provider: z.string().max(64), method: z.string().max(16), path: z.string().max(2000), status: num,
  durationMs: num, requestId: opt(z.string().max(200)), sessionExternalId: opt(z.string().max(200)), model: opt(str),
  params: z.unknown(), system: opt(hex), tools: opt(hex), messages: z.array(hex).max(100_000),
  response: z.unknown(), usage: z.unknown(), error: opt(z.string().max(20_000)),
});

export const batchSchema = z.object({
  v: z.literal(1), ledgerId: z.string().min(1).max(100), bundle: z.string().max(100),
  fromSeq: z.number().int(), toSeq: z.number().int(),
  rows: z.array(z.object({
    seq: z.number().int(), kind: z.enum(['session', 'message', 'call', 'counter', 'exchange', 'blob']), key: z.string().max(4000),
    data: z.record(z.string(), z.unknown()),
  })).min(1).max(20_000),
});

const date = (s: string | null): Date | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

function parseRow<T extends z.ZodType>(schema: T, row: { seq: number; data: unknown }): z.infer<T> {
  const r = schema.safeParse(row.data);
  if (!r.success) throw new BatchError(`row seq ${row.seq}: ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  return r.data;
}

export async function ingestBatch(device: { id: number; host: string }, batch: WireBatch): Promise<IngestResponse> {
  const { host } = device;
  const sessions: Array<{ seq: number; s: SessionInput }> = [];
  const messages: Array<{ seq: number; source: string; m: ParsedMessage & { sessionExternalId: string } }> = [];
  const calls: UsageCall[] = [];
  const counters: HermesCounters[] = [];
  const blobs: Array<z.infer<typeof blobData> & { json: string }> = [];
  const exchanges: Array<z.infer<typeof exchangeData> & { key: string }> = [];

  // Validate everything before touching the database: a bad row fails the batch cleanly.
  for (const row of batch.rows) {
    if (row.kind === 'session') {
      const d = parseRow(sessionData, row);
      sessions.push({ seq: row.seq, s: {
        source: d.source as SessionInput['source'], host, externalId: d.externalId, parentExternalId: d.parentExternalId,
        project: d.project, title: d.title, model: d.model, startedAt: date(d.startedAt), endedAt: date(d.endedAt),
        messageCount: d.messageCount, inputTokens: d.inputTokens, outputTokens: d.outputTokens, costUsd: d.costUsd,
        meta: { ...(d.meta ?? {}), ...(d.provider ? { provider: d.provider } : {}) }, b2Path: null,
      } });
    } else if (row.kind === 'message') {
      const d = parseRow(messageData, row);
      const src = row.key.split('|')[0]!;
      if (!source.safeParse(src).success) throw new BatchError(`row seq ${row.seq}: bad source in key`);
      messages.push({ seq: row.seq, source: src, m: { ...d, ts: date(d.ts) } });
    } else if (row.kind === 'call') {
      const d = parseRow(callData, row);
      calls.push({ ...d, host, ts: date(d.ts) ?? new Date(0) });
    } else if (row.kind === 'counter') {
      const d = parseRow(counterData, row);
      counters.push({ ...d, host, startedAt: date(d.startedAt), endedAt: date(d.endedAt) });
    } else if (row.kind === 'blob') {
      const d = parseRow(blobData, row);
      const json = JSON.stringify(d.body);
      // The hash is the blob's identity: recompute it so a body can never sit under the wrong one.
      if (createHash('sha256').update(json).digest('hex') !== d.sha) throw new BatchError(`row seq ${row.seq}: blob body does not match its sha`);
      blobs.push({ ...d, json });
    } else {
      const d = parseRow(exchangeData, row);
      if (!date(d.ts)) throw new BatchError(`row seq ${row.seq}: bad exchange ts`);
      exchanges.push({ ...d, key: row.key });
    }
  }

  const counts = { sessions: 0, messages: 0, calls: 0, counters: 0, exchanges: 0, blobs: 0 };
  await withTransaction(async (tx) => {
    const ids = new Map<string, number>();
    for (const { s } of sessions) {
      const r = await archive.upsertSession(tx, s);
      ids.set(`${s.source}|${s.externalId}`, r.id);
      if (r.changed) counts.sessions++;
    }
    const bySession = new Map<string, { source: string; msgs: ParsedMessage[] }>();
    for (const { source: src, m } of messages) {
      const k = `${src}|${m.sessionExternalId}`;
      const g = bySession.get(k) ?? bySession.set(k, { source: src, msgs: [] }).get(k)!;
      g.msgs.push(m);
    }
    for (const [k, g] of bySession) {
      let id = ids.get(k);
      if (id === undefined) {
        // The session row can arrive after its messages: it takes a new seq whenever it changes (a title
        // appears later, or a forked session's copied subagent file names another parent). A stub now;
        // the real row fills it in when it comes, through the same COALESCE upsert.
        const extId = k.slice(g.source.length + 1);
        const stub = await archive.upsertSession(tx, {
          source: g.source as SessionInput['source'], host, externalId: extId, parentExternalId: null, project: null,
          title: null, model: null, startedAt: null, endedAt: null, messageCount: null, inputTokens: null,
          outputTokens: null, costUsd: null, meta: {}, b2Path: null,
        });
        id = stub.id;
        ids.set(k, id);
      }
      counts.messages += await archive.upsertMessages(tx, id, g.msgs);
      // Hermes reports its own totals; every other harness's are counted from the messages.
      if (!g.source.startsWith('hermes')) await archive.refreshSessionStats(tx, id);
    }
    counts.calls = await usage.upsertCalls(tx, calls);
    counts.counters = await usage.recordHermesCounters(tx, counters, new Date());
    for (const b of blobs) {
      const r = await tx.query(
        `INSERT INTO llm_blobs (sha, kind, body, bytes, first_host) VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT (sha) DO NOTHING`,
        [b.sha, b.kind, JSON.stringify(clean(b.body)), Buffer.byteLength(b.json), host]);
      counts.blobs += r.rowCount ?? 0;
    }
    for (const e of exchanges) {
      const j = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(clean(v)));
      const r = await tx.query(
        `INSERT INTO llm_exchanges AS x (host, provider, exchange_key, request_id, session_external_id, ts, model, status, duration_ms,
           params, system_sha, tools_sha, message_shas, response, usage, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14::jsonb,$15::jsonb,$16)
         ON CONFLICT (host, exchange_key) DO UPDATE SET response=EXCLUDED.response, usage=EXCLUDED.usage, error=EXCLUDED.error,
           status=EXCLUDED.status, duration_ms=EXCLUDED.duration_ms
         WHERE (x.response, x.usage, x.error, x.status) IS DISTINCT FROM (EXCLUDED.response, EXCLUDED.usage, EXCLUDED.error, EXCLUDED.status)`,
        [host, e.provider, e.key, e.requestId, e.sessionExternalId, date(e.ts), e.model, Math.round(e.status), Math.round(e.durationMs),
          j(e.params), e.system, e.tools, e.messages, j(e.response), j(e.usage), e.error]);
      counts.exchanges += r.rowCount ?? 0;
    }
    await tx.query(
      `INSERT INTO ingest_batches (device_id, host, ledger_id, bundle, from_seq, to_seq, rows, counts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [device.id, host, batch.ledgerId, batch.bundle, batch.fromSeq, batch.toSeq, batch.rows.length, JSON.stringify(counts)]);
  });
  return { ok: true, host, rows: batch.rows.length, counts };
}
