import { describe, expect, it } from 'vitest';
import { replay, type EvidenceEvent, type ReplayWindow } from '../../shared/observatory.js';
import { archiveEvents } from '../src/addons/observatory/adapters.js';
const event = (id: string, at: number, kind: EvidenceEvent['kind'], extra: Partial<EvidenceEvent> = {}): EvidenceEvent => ({
  version: 1, id, at, observedAt: null, sequence: 0, part: 0, kind, session: 'archive:1', execution: null,
  actor: { kind: 'unknown', sender: null, channel: null, evidence: 'unrecorded' },
  source: { table: 'archive_messages', id, part: '0' }, precision: 'millisecond', confidence: 'recorded', ...extra,
});
const window = (): ReplayWindow => ({ version: 1, from: 10, to: 100, intervals: [
  { id: 'run:a', session: 'archive:1', start: 0, end: 30, host: 'test-host', runtime: 'codex', persona: 'builder', ticket: 'task-a', evidence: 'usage_runs' },
  { id: 'run:b', session: 'archive:2', start: 20, end: 40, host: 'test-host', runtime: 'codex', persona: 'builder', ticket: null, evidence: 'usage_runs' },
  { id: 'run:resume', session: 'archive:1', start: 70, end: 90, host: 'test-host', runtime: 'codex', persona: 'builder', ticket: null, evidence: 'usage_runs' },
], boundary: { tickets: {}, tools: {} }, events: [event('call', 15, 'tool_call', { occurrence: 'call' }), event('result', 25, 'tool_result', { parent: 'call', outcome: 'success' }), event('card', 50, 'ticket', { ticket: 'task-a', status: 'done' })] });
describe('observatory replay', () => {
  it('uses half-open intervals, distinct concurrency and resume gaps', () => {
    const w = window();
    for (const [t, ids] of [[10, ['run:a']], [20, ['run:a', 'run:b']], [30, ['run:b']], [40, []], [70, ['run:resume']], [90, []]] as const) expect(replay(w, t).active.map(x => x.id)).toEqual(ids);
  });
  it('does not leak future results or current card state; reverse seek is equivalent', () => {
    const w = window(); const before = replay(w, 20);
    expect(before.tools.call).toBe('pending'); expect(before.tickets['task-a']).toBeUndefined();
    expect(replay(w, 60).tools.call).toBe('success'); expect(replay(w, 60).tickets['task-a']).toBe('done');
    expect(replay(w, 20)).toEqual(before);
  });
  it('restores boundary state without mutation and deduplicates late imports', () => {
    const w = window(); w.boundary.tools.old = 'pending'; w.events = [w.events[2]!, w.events[1]!, w.events[0]!, w.events[0]!];
    expect(replay(w, 20).tools).toEqual({ old: 'pending', call: 'pending' }); expect(w.boundary.tools).toEqual({ old: 'pending' });
    expect(() => replay(w, 9)).toThrow();
  });
});
describe('archive evidence adapter', () => {
  it('exposes bounded structured path attempts without arguments, shell guesses or file contents', () => {
    const row = (id: number, tool: string, args: unknown) => ({ id, session_id: 1, seq: id, ts: new Date(id), role: 'assistant', kind: 'assistant', raw: { role: 'assistant', session_id: 's', tool_calls: [{ id: String(id), function: { name: tool, arguments: JSON.stringify(args) } }] }, text: '', host: 'lab', source: 'hermes', external_id: 's', harness: 'hermes', observed_at: null });
    const events = archiveEvents([row(1, 'read_file', { path: 'src/demo.ts' }), row(2, 'Write', { file_path: 'src/new.ts', content: 'SECRET_CONTENT' }), row(3, 'Bash', { command: 'cat src/demo.ts', path: 'guessed' })]);
    expect(events[0]?.target).toEqual({ path: 'src/demo.ts', operation: 'read' });
    expect(events[1]?.target).toEqual({ path: 'src/new.ts', operation: 'write' });
    expect(events[2]?.target).toBeUndefined();
    expect(JSON.stringify(events)).not.toMatch(/SECRET_CONTENT|cat src/);
  });

  it('expands parts, scopes reused IDs by session and occurrence, excludes text and human guesses', () => {
    const row = (id: number, session_id: number, seq: number, raw: unknown, role = 'assistant') => ({ id, session_id, seq, ts: new Date(id * 1000), role, kind: role, raw, text: 'private text', host: 'test-host', source: 'hermes', external_id: String(id), harness: 'hermes', observed_at: null });
    const call = { role: 'assistant', session_id: 's', tool_calls: [{ id: 'reuse', function: { name: 'read', arguments: '{}' } }] };
    const result = { role: 'tool', session_id: 's', tool_call_id: 'reuse', content: 'secret result' };
    const events = archiveEvents([row(1, 1, 1, call), row(2, 2, 1, call), row(3, 1, 2, result, 'tool'), row(4, 1, 3, call), row(5, 1, 4, result, 'tool'), row(6, 1, 5, { role: 'user', session_id: 's', content: 'scheduled prompt' }, 'user')]);
    const calls = events.filter(e => e.kind === 'tool_call'); const results = events.filter(e => e.kind === 'tool_result');
    expect(new Set(calls.map(e => e.occurrence)).size).toBe(3); expect(results.map(e => e.parent)).toEqual([calls[0]!.id, calls[2]!.id]);
    expect(events.find(e => e.kind === 'prompt')!.actor.kind).toBe('unknown');
    expect(JSON.stringify(events)).not.toMatch(/private text|secret result|scheduled prompt/);
  });
});

import { makeWindow } from '../src/addons/observatory/adapters.js';
import { Exports } from '../src/addons/observatory/exports.js';
import { authorizeDetail, authorizeExport, coverage, loadWindow, type ExportData } from '../src/addons/observatory/service.js';
import type { TxClient } from '../src/db.js';
import { moduleSet } from '../src/modules.js';
import { addonRoutes } from '../src/addons/index.js';
const dbFixture = (handler: (sql: string, args: readonly unknown[]) => unknown[]): TxClient => ({ query: async (sql, args = []) => ({ rows: handler(sql, args), rowCount: 0, command: 'SELECT', oid: 0, fields: [] }) } as TxClient);
const exportFixture = (): ExportData => ({ window: window(), refs: {}, diagnostics: { untimed: 0, unknownIntervals: 0, ambiguousSessions: 0, unpairedResults: 0, humanOrigin: 'unknown', liveExecutions: 'unsupported', historicalCompleteness: 'unknown', truncated: 0 } });

describe('boundary, pagination and authorization', () => {
  it('builds state strictly before window start and applies tied events at the cursor', () => {
    const w = makeWindow(10, 100, [event('old', 5, 'ticket', { ticket: 'old', status: 'ready' }), event('at', 10, 'ticket', { ticket: 'new', status: 'done' }), event('unknown', null, 'response')], []);
    expect(w.boundary.tickets).toEqual({ old: 'ready' });
    expect(w.boundary.provenance?.['ticket:old']?.event).toBe('old'); expect(replay(w, 10).tickets).toEqual({ old: 'ready', new: 'done' });
    expect(w.events.find(e => e.id === 'unknown')!.at).toBeNull();
  });
  it('pins immutable pages across late arrivals; binds exports to viewer and expires them', () => {
    let now = 0; const cache = new Exports(() => now); const data = exportFixture(); const token = cache.put('viewer-a', data);
    data.window.events.unshift(event('late', 11, 'response'));
    const first = cache.page('viewer-a', token, 0, 1); const second = cache.page('viewer-a', token, first.next!, 2);
    expect([...first.window.events, ...second.window.events].map(e => e.id)).toEqual(['call', 'result', 'card']);
    first.window.events[0]!.kind = 'system'; expect(cache.event('viewer-a', token, 'call').kind).toBe('tool_call');
    expect(() => cache.get('viewer-b', token)).toThrow(/expired/); now = 300_000; expect(() => cache.get('viewer-a', token)).toThrow(/expired/);
  });
  it('evicts bounded exports explicitly', () => {
    const cache = new Exports(); const token = cache.put('a', exportFixture());
    for (let i = 0; i < 8; i++) cache.put('a', exportFixture());
    expect(() => cache.get('a', token)).toThrow(/expired/);
  });
  it('does not mount disabled module', () => {
    expect(moduleSet('')).not.toContain('observatory');
    expect(addonRoutes(new Set(), {} as never)).toEqual([]);
    const routes = addonRoutes(new Set(['observatory']), { opts: { modules: new Set(['observatory']) } } as never);
    expect(routes.map(r => r.path)).toEqual(['/api/observatory']);
    expect(routes[0]!.mount).toBeUndefined();
  });
  it('denies detail when source is disabled or no longer visible', async () => {
    const db = dbFixture(() => []);
    await expect(authorizeDetail(db, event('1', 1, 'response'), new Set())).rejects.toThrow(/disabled/);
    await expect(authorizeDetail(db, event('1', 1, 'response'), new Set(['usage']))).rejects.toThrow(/visible/);
    const data = exportFixture(); data.refs.archive_messages = ['1'];
    await expect(authorizeExport(db, data, new Set(['usage']))).rejects.toThrow(/visibility changed/);
  });
  it('marks disabled sources without querying them', async () => {
    const db = dbFixture(() => { throw new Error('unexpected source read'); });
    const result = await coverage(db, { from: 0, to: 100 }, new Set());
    expect(result.sources.map(s => s.status)).toEqual(Array(5).fill('disabled'));
  });
  it('keeps usage rows separate from tools and rejects unknown execution ends', async () => {
    const db = dbFixture(sql => {
      if (sql.includes('FROM archive_messages m JOIN')) return [];
      if (sql.includes('FROM usage_runs r WHERE')) return [
        { host: 'test-host', run_id: 'closed', session_id: 's', runtime: 'codex', agent_name: 'builder', task_id: 't', started_at: new Date(0), ended_at: new Date(30), archive_ids: [1] },
        { host: 'test-host', run_id: 'stale', session_id: 's', runtime: 'codex', agent_name: 'builder', task_id: 't', started_at: new Date(0), ended_at: null, archive_ids: [1] },
      ];
      if (sql.includes('FROM usage_calls u WHERE')) return [{ id: 9, ts: new Date(20), model: 'test-model', input_tokens: 10, output_tokens: 5, thinking_tokens: 2, host: 'test-host', run_id: 'closed', archive_ids: [1] }];
      throw new Error(sql);
    });
    const result = await loadWindow(db, { from: 10, to: 100 }, new Set(['usage']));
    expect(result.window.events.map(e => e.kind)).toEqual(['usage']); expect(result.diagnostics.unknownIntervals).toBe(1);
    expect(replay(result.window, 20).active).toHaveLength(1);
    expect(replay(result.window, 30).active).toEqual([]);
  });
});

import { observatoryRouter } from '../src/addons/observatory/routes.js';
describe('observatory request bounds', () => {
  const invoke = (path: string, query: object) => new Promise<unknown>((resolve, reject) => {
    const router = observatoryRouter(new Set());
    const layer = router.stack.find((l: any) => l.route?.path === path) as any;
    layer.route.stack[0].handle({ query }, { locals: {}, json: resolve }, reject);
  });
  it('rejects reversed, wide and malformed ranges before opening a database', async () => {
    for (const query of [{ from: 'bad', to: 'bad' }, { from: '2025-01-02T00:00:00Z', to: '2025-01-01T00:00:00Z' }, { from: '2025-01-01T00:00:00Z', to: '2025-01-03T00:00:00Z' }]) await expect(invoke('/window', query)).rejects.toHaveProperty('status', 400);
    await expect(invoke('/coverage', { from: 'bad', to: 'bad' })).rejects.toHaveProperty('status', 400);
  });
  it('rejects paging with expired token and mixed filters explicitly', async () => {
    await expect(invoke('/window', { export: '00000000-0000-4000-8000-000000000000' })).rejects.toHaveProperty('status', 410);
    await expect(invoke('/window', { export: '00000000-0000-4000-8000-000000000000', host: 'test-host' })).rejects.toHaveProperty('status', 400);
  });
});

describe('uncertain evidence', () => {
  it('does not invent causal links for ambiguous reused IDs, untimed or inverted results', () => {
    const row = (id: number, seq: number, ts: Date | null, result = false) => ({ id, session_id: 1, seq, ts, role: result ? 'tool' : 'assistant', kind: 'message', host: 'test-host', source: 'hermes', harness: 'hermes', external_id: 's', observed_at: null, text: '', raw: result ? { role: 'tool', session_id: 's', tool_call_id: 'x', content: 'result' } : { role: 'assistant', session_id: 's', tool_calls: [{ id: 'x', function: { name: 'read', arguments: '{}' } }] } });
    const a = row(1, 1, new Date(10)), b = row(2, 2, new Date(20)), r = row(3, 3, new Date(30), true);
    expect(archiveEvents([a, b, r]).find(e => e.kind === 'tool_result')!.parent).toBeUndefined();
    expect(archiveEvents([a, row(3, 2, null, true)]).find(e => e.kind === 'tool_result')!.parent).toBeUndefined();
    expect(archiveEvents([a, row(3, 2, new Date(0), true)]).find(e => e.kind === 'tool_result')!.parent).toBeUndefined();
    expect(archiveEvents([a, a, r]).filter(e => e.kind === 'tool_call')).toHaveLength(1);
  });
  it('exposes only thinking availability and never substitutes token totals for thoughts', () => {
    const events = archiveEvents([{ id: 1, session_id: 1, seq: 1, ts: new Date(10), role: 'assistant', kind: 'assistant', raw: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden reasoning text' }] } }, text: 'hidden reasoning text', host: 'test-host', source: 'claude-code', external_id: 's', harness: 'claude-code', observed_at: null }]);
    expect(events[0]!.thinking).toBe('available-in-source'); expect(JSON.stringify(events)).not.toContain('hidden reasoning text');
  });
  it('rejects oversized source windows instead of creating incomplete replay', async () => {
    const db = dbFixture(() => Array(5001).fill({}));
    await expect(loadWindow(db, { from: 0, to: 100 }, new Set(['usage']))).rejects.toHaveProperty('status', 413);
  });
});

describe('recorded ordering', () => {
  it('preserves same-time source part order without manufacturing timestamps', () => {
    const events = archiveEvents([{ id: 1, session_id: 1, seq: 4, ts: new Date(10), role: 'assistant', kind: 'assistant', raw: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'response' }, { type: 'tool_use', id: 'one', name: 'read', input: {} }, { type: 'tool_use', id: 'two', name: 'write', input: {} }] } }, text: '', host: 'test-host', source: 'claude-code', external_id: 's', harness: 'claude-code', observed_at: null }]);
    expect(events.map(e => e.kind)).toEqual(['thinking', 'response', 'tool_call', 'tool_call']);
    expect(events.map(e => e.part)).toEqual([0, 1, 2, 3]); expect(new Set(events.map(e => e.at))).toEqual(new Set([10]));
    expect(new Set(events.map(e => e.id)).size).toBe(4);
    expect(() => replay(window(), 100)).toThrow(/outside/);
  });
});
