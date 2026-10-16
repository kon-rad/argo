import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { syncUsage } from '../src/usage/sync.js';
import { truncateAll } from './helpers.js';

const line = (o: object) => JSON.stringify(o) + '\n';
const assistant = (uuid: string, id: string, out: number, ts: string) => line({
  type: 'assistant', uuid, parentUuid: null, timestamp: ts, sessionId: 'sess-1', cwd: '/home/agent/secondBrain',
  entrypoint: 'sdk-cli', message: { id, model: 'claude-opus-5-5', role: 'assistant',
    content: [{ type: 'text', text: `answer ${id}` }], usage: { input_tokens: 5, output_tokens: out } },
});

let root: string;
let paths: { claudeProjectsDir: string; runsDir: string; statuslineLog: string };

beforeEach(async () => {
  await truncateAll();
  root = mkdtempSync(join(tmpdir(), 'usage-sync-'));
  const proj = join(root, 'projects', '-home-hermes-secondBrain');
  mkdirSync(join(proj, 'sess-1', 'subagents'), { recursive: true });
  writeFileSync(join(proj, 'sess-1.jsonl'),
    line({ type: 'user', uuid: 'u1', timestamp: '2026-10-13T10:00:00Z', message: { role: 'user', content: 'Work kanban task t_1' } }) +
    assistant('a1', 'msg_1', 40, '2026-10-13T10:00:05Z') + assistant('a2', 'msg_1', 40, '2026-10-13T10:00:06Z'));
  writeFileSync(join(proj, 'sess-1', 'subagents', 'agent-x.jsonl'),
    line({ ...JSON.parse(assistant('s1', 'msg_sub', 7, '2026-10-13T10:00:07Z')), isSidechain: true }));
  mkdirSync(join(root, 'runs'));
  writeFileSync(join(root, 'runs', 't_1.jsonl'),
    line({ type: 'cc_dispatch', task_id: 't_1', board: 'exo', lane: 'cc-coder', model: 'opus', at: '2026-10-13T10:00:00Z' }) +
    line({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', duration_ms: 9000, num_turns: 2, total_cost_usd: 0.1 }));
  paths = { claudeProjectsDir: join(root, 'projects'), runsDir: join(root, 'runs'), statuslineLog: join(root, 'plan.ndjson') };
  writeFileSync(paths.statuslineLog, line({ at: '2026-10-13T10:01:00Z', rate_limits: { five_hour: { used_percentage: 12, resets_at: 1791879600 } } }));
});

describe('syncUsage', () => {
  it('loads calls, the transcript, the run and the plan reading, and a re-run changes nothing', async () => {
    const first = await syncUsage(paths, 'droplet');
    expect(first).toMatchObject({ calls: 2, runs: 1, plan: 1, attached: 1, errors: [] });
    const calls = await query(`SELECT call_id, output_tokens, is_sidechain FROM usage_calls ORDER BY call_id`);
    expect(calls.rows).toEqual([
      { call_id: 'msg_1', output_tokens: 40, is_sidechain: false },
      { call_id: 'msg_sub', output_tokens: 7, is_sidechain: true }]);
    const msgs = await query(`SELECT count(*)::int n FROM archive_messages m JOIN archive_sessions s ON s.id=m.session_id
                              WHERE s.source='claude-code' AND s.host='droplet'`);
    expect(msgs.rows[0]!.n).toBe(4);
    const run = await query(`SELECT run_id, task_id, lane FROM usage_runs`);
    expect(run.rows).toEqual([{ run_id: 't_1', task_id: 't_1', lane: 'cc-coder' }]);
    // The call in the run's window carries the run; the subagent's call, in another session, does not.
    const attached = await query(`SELECT call_id, run_id, action FROM usage_calls ORDER BY call_id`);
    expect(attached.rows).toEqual([{ call_id: 'msg_1', run_id: 't_1', action: 'reply' }, { call_id: 'msg_sub', run_id: null, action: 'reply' }]);

    const second = await syncUsage(paths, 'droplet');
    expect(second).toMatchObject({ calls: 0, sessions: 0, messages: 0, runs: 0, plan: 0, attached: 0 });
  });

  it('reads only appended bytes on the next pass', async () => {
    await syncUsage(paths, 'droplet');
    appendFileSync(join(paths.claudeProjectsDir, '-home-hermes-secondBrain', 'sess-1.jsonl'),
      assistant('a3', 'msg_2', 11, '2026-10-13T10:02:00Z'));
    const next = await syncUsage(paths, 'droplet');
    expect(next.calls).toBe(1);
    expect((await query(`SELECT count(*)::int n FROM usage_calls`)).rows[0]!.n).toBe(3);
  });
});
