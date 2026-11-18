import { describe, expect, it } from 'vitest';
import { buildLive, stopProcess, type SessionInfo } from '../src/usage/live.js';
import type { RunningRow } from '../src/usage/running.js';

const NOW = new Date('2026-10-27T12:00:00Z');
const proc = (o: Partial<RunningRow>): RunningRow => ({ kind: 'bot', name: 'atlas', runtime: 'claude-code', model: 'opus', pid: 100, user: 'agent', elapsedSec: 120,
  startedAt: '2026-10-27T11:58:00Z', runId: 'atlas-1', reason: 'task', ref: 't_abc123', state: 'running', configured: null, detail: null, ...o });
const sess = (o: Partial<SessionInfo>): SessionInfo => ({ host: 'laptop', source: 'claude-code', externalId: 's1', title: 'Fix the thing', model: 'sonnet',
  startedAt: new Date('2026-10-27T11:50:00Z'), endedAt: new Date('2026-10-27T11:59:30Z'), updatedAt: new Date('2026-10-27T11:59:31Z'),
  messages: 14, input: 1000, output: 250, project: 'proj', ...o });
const hosts = [{ slug: 'srv', display: 'Server', kind: 'server' }, { slug: 'laptop', display: 'Laptop', kind: 'laptop' }];

describe('buildLive', () => {
  it('groups by machine and joins the card title, turns and tokens', () => {
    const cards = new Map([['t_abc123', { cardId: 't_abc123', title: 'Write the doc', turns: 7, tokens: 5000 }]]);
    const out = buildLive([proc({})], cards, [sess({})], hosts, 'srv', NOW);
    expect(out.total).toBe(2);
    expect(out.machines.map((m) => m.slug)).toEqual(['srv', 'laptop']);
    const a = out.machines[0]!.agents[0]!;
    expect(a).toMatchObject({ source: 'process', stoppable: true, pid: 100, turns: 7, task: { cardId: 't_abc123', label: 'Write the doc' } });
    const s = out.machines[1]!.agents[0]!;
    expect(s).toMatchObject({ source: 'session', stoppable: false, turns: 14, tokens: { input: 1000, output: 250 }, log: { host: 'laptop', externalId: 's1' } });
  });

  it('adds a machine nobody registered, so new machines scale up with no code change', () => {
    const out = buildLive([], new Map(), [sess({ host: 'new-box' })], hosts, 'srv', NOW);
    expect(out.machines.map((m) => [m.slug, m.display])).toEqual([['srv', 'Server'], ['new-box', 'new-box']]);
  });

  it('drops idle sessions, and server sessions a listed process already covers', () => {
    const stale = sess({ externalId: 'old', endedAt: new Date('2026-10-27T11:50:00Z'), updatedAt: new Date('2026-10-27T11:50:01Z') });
    const dup = sess({ externalId: 'dup', host: 'srv' });
    const out = buildLive([proc({})], new Map(), [stale, dup], hosts, 'srv', NOW);
    expect(out.total).toBe(1);
  });
});

describe('stopProcess', () => {
  it('refuses a pid that is not an agent process', async () => {
    const r = await stopProcess(2147483000, false);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});
