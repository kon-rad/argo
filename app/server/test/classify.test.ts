import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { classify, decide, defaultSchemasDir, loadSchema, modelIdFor, parseSchema, sourceAllowed, stateHash, wireQuestion, type ClassifyDeps } from '../src/classify/index.js';
import { main } from '../src/cli-classify.js';
import { query } from '../src/db.js';
import { truncateAll } from './helpers.js';

// The classify step (docs/zen-runtime.md, section 4.2): schemas, thresholds, privacy, cache, cap, fallthrough.
const SETTINGS = { allow: ['platform', 'Research/'], model: 'openrouter/typesafe/jev-1.14', schemasDir: '.agents/classify' };

type Reply = { status?: number; body?: unknown; fail?: string };
/** A fetch that answers from a script and records every request body. */
function fakeFetch(replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: Object.fromEntries(Object.entries(init?.headers ?? {})), body: JSON.parse(String(init?.body)) });
    const r = replies.shift() ?? { status: 500 };
    if (r.fail) throw new Error(r.fail);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}
const choice = (choice: string, probabilities: Record<string, number>, confidence: number, input_tokens = 1200) => ({
  body: { answers: { answer: { type: 'choice', choice, probabilities, confidence } }, usage: { input_tokens, output_tokens: 0 } },
});
const deps = (over: Partial<ClassifyDeps> = {}): ClassifyDeps => ({ settings: SETTINGS, provider: 'openrouter', apiKey: 'k', dailyTokens: 2_000_000, ...over });
const wake = { recipient: 'bolt', recipient_role: 'engineer', author: 'sage', kind: 'message', body: 'please look at the failing build' };

beforeEach(truncateAll);

describe('schemas', () => {
  it('ships three defaults that load and validate', () => {
    for (const d of ['wake-gate', 'card-tier', 'run-outcome']) {
      const s = loadSchema(d, [defaultSchemasDir()]);
      expect(s.decision).toBe(d);
      expect(s.primitive).toBe('choice');
      expect(s.escalate).toBeLessThanOrEqual(s.act);
    }
    expect(loadSchema('wake-gate', [defaultSchemasDir()]).skipOptions).toEqual(['fyi', 'ack']);
  });
  it('a vault file wins over the default, and a broken one is an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'classify-'));
    writeFileSync(join(dir, 'wake-gate.json'), JSON.stringify({ decision: 'wake-gate', version: '2', primitive: 'choice', question: 'q', options: ['act', 'fyi'], skipOptions: ['fyi'], act: 0.95, escalate: 0.6, privacy: 'shared' }));
    expect(loadSchema('wake-gate', [dir, defaultSchemasDir()]).version).toBe('2');
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ decision: 'bad', version: '1', primitive: 'choice', question: 'q', act: 0.5, escalate: 0.9, privacy: 'shared' }));
    expect(() => loadSchema('bad', [dir])).toThrow(/options.*escalate|escalate.*options/s);
    expect(() => loadSchema('nope', [dir])).toThrow(/no schema/);
    expect(() => loadSchema('Bad Name', [dir])).toThrow(/lowercase/);
    expect(() => parseSchema({ decision: 'x', version: '1', primitive: 'score', question: 'q', min: 1, max: 5, criteria: ['a', 'b'], act: 0.5, escalate: 0.1, privacy: 'public' })).toThrow(/rubric/);
  });
  it('writes the wire question in pi-ai\'s ClassifierQuestion shape', () => {
    const s = loadSchema('wake-gate', [defaultSchemasDir()]);
    const q = wireQuestion(s);
    expect(q.type).toBe('choice');
    expect(Object.keys((q as { criteria: Record<string, string> }).criteria)).toEqual(['act', 'answer', 'fyi', 'ack']);
    const b = wireQuestion(parseSchema({ decision: 'b', version: '1', primitive: 'bool', question: 'q?', criteria: { true: 'T', false: 'F' }, act: 0.9, escalate: 0.1, privacy: 'public' }));
    expect(b).toEqual({ type: 'noul', instructions: 'q?', criteria: { true: 'T', false: 'F' } });
    const sc = wireQuestion(parseSchema({ decision: 's', version: '1', primitive: 'score', question: 'q', min: 0, max: 2, act: 0.5, escalate: 0.1, privacy: 'public' }));
    expect(sc).toEqual({ type: 'score', instructions: 'q', criteria: ['0', '1', '2'] });
  });
  it('maps the model spec per provider and hashes states canonically', () => {
    expect(modelIdFor('openrouter', 'openrouter/typesafe/jev-1.14')).toBe('typesafe/jev-1.14');
    expect(modelIdFor('typesafe', 'openrouter/typesafe/jev-1.14')).toBe('jev-1.14');
    expect(stateHash({ a: 1, b: { d: [1, 2], c: 'x' } })).toBe(stateHash({ b: { c: 'x', d: [1, 2] }, a: 1 }));
    expect(stateHash({ a: 1 })).not.toBe(stateHash({ a: 2 }));
  });
  it('allows an exact channel or a folder prefix, never a near miss', () => {
    expect(sourceAllowed('platform', SETTINGS.allow)).toBe(true);
    expect(sourceAllowed('Research/ai/x.md', SETTINGS.allow)).toBe(true);
    expect(sourceAllowed('Research-private/x.md', SETTINGS.allow)).toBe(false);
    expect(sourceAllowed('platform-secret', SETTINGS.allow)).toBe(false);
    expect(sourceAllowed(null, SETTINGS.allow)).toBe(false);
  });
});

describe('thresholds', () => {
  const gate = loadSchema('wake-gate', [defaultSchemasDir()]);
  const tier = loadSchema('card-tier', [defaultSchemasDir()]);
  it('wake gate: skip only on a confident nothing-to-do, act otherwise, escalate in between', () => {
    expect(decide(gate, { type: 'choice', choice: 'ack', probabilities: { act: 0.02, answer: 0.03, fyi: 0.4, ack: 0.55 }, confidence: 0.55 }).action).toBe('skip');
    expect(decide(gate, { type: 'choice', choice: 'act', probabilities: { act: 0.7, answer: 0.2, fyi: 0.05, ack: 0.05 }, confidence: 0.7 }).action).toBe('act');
    expect(decide(gate, { type: 'choice', choice: 'fyi', probabilities: { act: 0.3, answer: 0.1, fyi: 0.5, ack: 0.1 }, confidence: 0.5 }).action).toBe('escalate');
  });
  it('card tier: act at or above 0.85 confidence, else keep the default (escalate), review under 0.5', () => {
    expect(decide(tier, { type: 'choice', choice: 'mid', probabilities: { mid: 0.9 }, confidence: 0.9 })).toMatchObject({ action: 'act', answer: 'mid', review: false });
    expect(decide(tier, { type: 'choice', choice: 'mid', probabilities: { mid: 0.6 }, confidence: 0.6 })).toMatchObject({ action: 'escalate', review: false });
    expect(decide(tier, { type: 'choice', choice: 'mid', probabilities: { mid: 0.4 }, confidence: 0.4 })).toMatchObject({ action: 'escalate', review: true });
  });
  it('bool and score', () => {
    const b = parseSchema({ decision: 'b', version: '1', primitive: 'bool', question: 'q', act: 0.9, escalate: 0.2, privacy: 'public' });
    expect(decide(b, { type: 'noul', noul: 0.95 })).toMatchObject({ action: 'act', answer: 'yes' });
    expect(decide(b, { type: 'noul', noul: 0.1 })).toMatchObject({ action: 'skip', answer: 'no' });
    expect(decide(b, { type: 'noul', noul: 0.6 })).toMatchObject({ action: 'escalate', answer: 'yes' });
    const s = parseSchema({ decision: 's', version: '1', primitive: 'score', question: 'q', min: 0, max: 4, act: 0.7, escalate: 0.3, privacy: 'public' });
    expect(decide(s, { type: 'score', score: 3, confidence: 0.8 })).toMatchObject({ action: 'act', answer: '3' });
    expect(decide(s, { type: 'score', score: 1, confidence: 0.2 })).toMatchObject({ action: 'escalate', review: true });
  });
});

describe('classify()', () => {
  it('sends one System One request to OpenRouter and writes an act row with its cost', async () => {
    const f = fakeFetch([choice('act', { act: 0.8, answer: 0.1, fyi: 0.05, ack: 0.05 }, 0.8)]);
    const r = await classify({ decision: 'wake-gate', state: wake, source: 'platform', runId: 'bolt-1', agentName: 'bolt', ref: '42' }, deps({ fetch: f.fetch }));
    expect(r).toMatchObject({ action: 'act', answer: 'act', confidence: 0.8, model: 'openrouter/typesafe/jev-1.14', inputTokens: 1200, cached: false, error: null });
    expect(r.costUsd).toBeCloseTo((1200 * 0.042) / 1e6, 12);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(f.calls[0]!.headers.authorization).toBe('Bearer k');
    expect(f.calls[0]!.body).toMatchObject({ model: 'typesafe/jev-1.14', state: wake });
    expect((f.calls[0]!.body.questions as { answer: { type: string } }).answer.type).toBe('choice');
    const { rows } = await query(`SELECT decision, schema_version, action, answer, input_level, run_id, agent_name, ref, input_tokens, error FROM classify_decisions`);
    expect(rows).toEqual([{ decision: 'wake-gate', schema_version: '1', action: 'act', answer: 'act', input_level: 'shared', run_id: 'bolt-1', agent_name: 'bolt', ref: '42', input_tokens: 1200, error: null }]);
  });
  it('skips a confident acknowledgement and answers the same state from the cache without a second call', async () => {
    const f = fakeFetch([choice('ack', { act: 0.02, answer: 0.03, fyi: 0.25, ack: 0.7 }, 0.7)]);
    const a = await classify({ decision: 'wake-gate', state: wake, source: 'platform' }, deps({ fetch: f.fetch }));
    expect(a.action).toBe('skip');
    const b = await classify({ decision: 'wake-gate', state: { ...wake }, source: 'platform' }, deps({ fetch: f.fetch }));
    expect(b).toMatchObject({ action: 'skip', answer: 'ack', cached: true, id: a.id });
    expect(f.calls).toHaveLength(1);
    expect((await query(`SELECT count(*)::int AS n FROM classify_decisions`)).rows[0]!.n).toBe(1);
  });
  it('refuses a source off the allow list without calling anyone', async () => {
    const f = fakeFetch([]);
    const r = await classify({ decision: 'wake-gate', state: wake, source: 'launch-room' }, deps({ fetch: f.fetch }));
    expect(r).toMatchObject({ action: 'fallthrough', error: 'privacy', answer: null });
    expect(f.calls).toHaveLength(0);
    expect((await query(`SELECT input_level, action FROM classify_decisions`)).rows).toEqual([{ input_level: 'refused', action: 'fallthrough' }]);
    expect((await classify({ decision: 'wake-gate', state: wake }, deps({ fetch: f.fetch }))).error).toBe('privacy');
  });
  it('falls through with no provider or key, and logs it', async () => {
    const f = fakeFetch([]);
    expect((await classify({ decision: 'wake-gate', state: wake, source: 'platform' }, deps({ fetch: f.fetch, provider: 'none' }))).error).toBe('no-key');
    expect((await classify({ decision: 'wake-gate', state: wake, source: 'platform' }, deps({ fetch: f.fetch, apiKey: null }))).error).toBe('no-key');
    expect(f.calls).toHaveLength(0);
    expect((await query(`SELECT count(*)::int AS n FROM classify_decisions WHERE action = 'fallthrough' AND error = 'no-key'`)).rows[0]!.n).toBe(2);
  });
  it('stops at the daily token cap', async () => {
    const f = fakeFetch([choice('act', { act: 0.9, answer: 0.1, fyi: 0, ack: 0 }, 0.9, 1500), choice('act', { act: 0.9, answer: 0.1, fyi: 0, ack: 0 }, 0.9)]);
    expect((await classify({ decision: 'wake-gate', state: wake, source: 'platform' }, deps({ fetch: f.fetch, dailyTokens: 1000 }))).action).toBe('act');
    const r = await classify({ decision: 'wake-gate', state: { ...wake, body: 'another' }, source: 'platform' }, deps({ fetch: f.fetch, dailyTokens: 1000 }));
    expect(r).toMatchObject({ action: 'fallthrough', error: 'budget' });
    expect(f.calls).toHaveLength(1);
  });
  it('retries once on a 5xx or a network error, then falls through with the provider error', async () => {
    const f = fakeFetch([{ status: 503 }, choice('mid', { mid: 0.9 }, 0.9)]);
    const card = { title: 'add a test', body: 'one file', lane: 'cc-coder' };
    expect((await classify({ decision: 'card-tier', state: card, source: 'platform' }, deps({ fetch: f.fetch }))).answer).toBe('mid');
    expect(f.calls).toHaveLength(2);
    const g = fakeFetch([{ fail: 'ECONNRESET' }, { fail: 'ECONNRESET' }]);
    const r = await classify({ decision: 'card-tier', state: { ...card, title: 'other' }, source: 'platform' }, deps({ fetch: g.fetch }));
    expect(r).toMatchObject({ action: 'fallthrough', error: 'provider: ECONNRESET' });
    const h = fakeFetch([{ status: 400, body: { error: 'bad' } }]);
    expect((await classify({ decision: 'card-tier', state: { ...card, title: 'third' }, source: 'platform' }, deps({ fetch: h.fetch }))).error).toMatch(/^provider: HTTP 400/);
    expect(h.calls).toHaveLength(1);
    const bad = fakeFetch([{ body: { answers: { answer: { type: 'score', score: 1, confidence: 1 } } } }]);
    expect((await classify({ decision: 'card-tier', state: { ...card, title: 'fourth' }, source: 'platform' }, deps({ fetch: bad.fetch }))).error).toMatch(/expected a choice/);
  });
  it('labels a run outcome with the schema pin and the escalate band', async () => {
    const f = fakeFetch([choice('no-op', { 'did-work': 0.3, 'no-op': 0.45, blocked: 0.15, failed: 0.1 }, 0.45)]);
    const r = await classify({ decision: 'run-outcome', state: { result: 'nothing for me', stopped: 'done' }, source: 'platform', runId: 'bolt-2' }, deps({ fetch: f.fetch }));
    expect(r).toMatchObject({ action: 'escalate', answer: 'no-op', review: false });
  });
});

describe('cli', () => {
  it('exits 0 on a decision, 3 on fallthrough, and lists and labels decisions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'classify-cli-'));
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify(wake));
    const lines: string[] = [];
    const out = (s: string): void => void lines.push(s);
    // The CLI uses the real settings (no allow list on this machine), so every call is a privacy fallthrough.
    expect(await main(['wake-gate', '--state-file', file, '--source', 'platform', '--json'], out)).toBe(3);
    const r = JSON.parse(lines[0]!) as { action: string; error: string; id: number };
    expect(r).toMatchObject({ action: 'fallthrough', error: 'privacy' });
    lines.length = 0;
    expect(await main(['recent'], out)).toBe(0);
    expect(lines[0]).toMatch(/^id\s+when\s+decision/);
    expect(lines[0]).toMatch(/wake-gate\s+fallthrough/);
    lines.length = 0;
    expect(await main(['label', String(r.id), 'right'], out)).toBe(0);
    expect((await query(`SELECT label, labelled_by FROM classify_decisions WHERE id = $1`, [r.id])).rows[0]).toEqual({ label: 'right', labelled_by: 'owner' });
    await expect(main(['label', '999999', 'wrong'], out)).rejects.toThrow(/no decision/);
    await expect(main(['label', 'x', 'maybe'], out)).rejects.toThrow(/right\|wrong/);
    await expect(main(['wake-gate'], out)).rejects.toThrow(/--state-file/);
    writeFileSync(file, '[1]');
    await expect(main(['wake-gate', '--state-file', file], out)).rejects.toThrow(/JSON object/);
    lines.length = 0;
    expect(await main([], out)).toBe(0);
    expect(lines[0]).toMatch(/^secondbrain classify/);
  });
});
