import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db.js';
import { summaryConfig } from '../src/summaries/config.js';
import { runSummaries } from '../src/summaries/run.js';
import { truncateAll } from './helpers.js';
import { sse } from './summaries-helpers.js';

const cfg = summaryConfig();
const ENV = { SUMMARIES_M1_URL: 'http://m1.invalid:11434', TOGETHER_API_KEY: 'tg-fake-key-for-tests-0001', OPENROUTER_API_KEY: 'or-fake-key-for-tests-0002' };

const ANSWER = JSON.stringify({
  request: 'Fix the discount bug on card t_ab12cd34.',
  done: 'Edited /work/shop/src/billing/invoice.ts to deduplicate codes and ran the tests.',
  learned: 'Repeated codes stacked.',
  open_items: '',
  outcome: 'finished',
  facts: [{ subject: 'invoice discounts', claim: 'Discount codes are deduplicated in invoice.ts before applying.' }],
});

const msg = (type: 'user' | 'assistant', content: unknown) => ({ type, uuid: `u${Math.random()}`, message: { role: type, content } });
let n = 0;
async function session(ext: string, rows: unknown[], over: { parent?: string; endedMinAgo?: number; source?: string } = {}): Promise<number> {
  const ended = over.endedMinAgo ?? 120;
  const { rows: [s] } = await query<{ id: number }>(
    `INSERT INTO archive_sessions (source, host, external_id, parent_external_id, project, started_at, ended_at, message_count)
     VALUES ($1,'droplet',$2,$3,'shop', now() - make_interval(mins => $4 + 10), now() - make_interval(mins => $4), $5) RETURNING id`,
    [over.source ?? 'claude-code', ext, over.parent ?? null, ended, rows.length]);
  let seq = 0;
  for (const raw of rows) {
    await query(`INSERT INTO archive_messages (session_id, seq, external_id, role, kind, content_text, raw, raw_sha) VALUES ($1,$2,$3,'x','x','',$4,$5)`,
      [s!.id, seq++, `m${n++}`, JSON.stringify(raw), `sha${n}`]);
  }
  return s!.id;
}

const convo = () => [
  msg('user', 'Fix the discount bug on card t_ab12cd34'),
  msg('assistant', [{ type: 'text', text: 'Reading the code.' }]),
  msg('assistant', [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/work/shop/src/billing/invoice.ts' } }]),
  msg('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
  msg('assistant', [{ type: 'text', text: 'Fixed and tests pass.' }]),
  msg('user', 'Thanks, looks good'),
];

const fetchOk = (calls: string[]) => (async (url: string) => { calls.push(url); return sse(ANSWER); }) as unknown as typeof fetch;

beforeEach(async () => {
  await truncateAll();
  n = 0;
});

describe('runSummaries', () => {
  it('writes a summary with computed metrics, candidate facts and the writer that answered', async () => {
    const id = await session('s1', convo());
    await query(`INSERT INTO usage_calls (source, host, call_id, session_external_id, ts, model, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens)
                 VALUES ('claude-code','droplet','c1','s1', now(), 'claude-opus-5-5', 10, 100, 1000, 50)`);
    const calls: string[] = [];
    const r = await runSummaries({ cfg, deps: { environment: ENV, fetchFn: fetchOk(calls) } });
    expect(r).toMatchObject({ considered: 1, written: 1, failed: 0, tokens: { input: 120, output: 40 } });
    expect(calls).toEqual(['http://m1.invalid:11434/v1/chat/completions']);

    const { rows: [s] } = await query(`SELECT * FROM agent_summaries WHERE session_id = $1`, [id]);
    expect(s).toMatchObject({ status: 'ok', outcome: 'finished', harness: 'claude-code', host: 'droplet', writer_provider: 'ollama', writer_model: cfg.chain[0]!.model, writer_input_tokens: 120 });
    expect(s.touched.files_edited).toEqual(['/work/shop/src/billing/invoice.ts']);
    expect(s.touched.cards).toEqual(['t_ab12cd34']);
    expect(s.metrics).toMatchObject({ prompts: 2, tool_calls: 1, error_steps: 0, calls: 1, input_tokens: 10, output_tokens: 50, models: ['claude-opus-5-5'] });
    const { rows: facts } = await query(`SELECT subject, status FROM agent_summary_facts WHERE summary_id = $1`, [s.id]);
    expect(facts).toEqual([{ subject: 'invoice discounts', status: 'proposed' }]);
    // A candidate is not memory until promoted.
    expect((await query(`SELECT 1 FROM memory_facts`)).rowCount).toBe(0);
  });

  it('is idempotent, and re-summarizes only when the session changed', async () => {
    const id = await session('s1', convo());
    const calls: string[] = [];
    const deps = { environment: ENV, fetchFn: fetchOk(calls) };
    await runSummaries({ cfg, deps });
    const again = await runSummaries({ cfg, deps });
    expect(again.considered).toBe(0); // nothing newer than the summary
    expect(calls).toHaveLength(1);

    await query(`INSERT INTO archive_messages (session_id, seq, external_id, role, kind, content_text, raw, raw_sha) VALUES ($1,99,'extra','x','x','',$2,'shaX')`,
      [id, JSON.stringify(msg('user', 'One more thing: also update the docs'))]);
    await query(`UPDATE archive_sessions SET updated_at = now() WHERE id = $1`, [id]);
    const third = await runSummaries({ cfg, deps });
    expect(third.written).toBe(1);
    expect(calls).toHaveLength(2);
    expect((await query(`SELECT 1 FROM agent_summaries`)).rowCount).toBe(1);
  });

  it('keeps rejected candidates when a summary is rewritten, and does not propose the same claim again', async () => {
    const id = await session('s1', convo());
    const deps = { environment: ENV, fetchFn: fetchOk([]) };
    await runSummaries({ cfg, deps });
    await query(`UPDATE agent_summary_facts SET status = 'rejected'`);
    await runSummaries({ cfg, deps, force: true, sessionId: id });
    const { rows } = await query(`SELECT status FROM agent_summary_facts ORDER BY id`);
    expect(rows.map((r) => r.status)).toEqual(['rejected']);
  });

  it('records short sessions as skipped without calling a model', async () => {
    await session('tiny', [msg('user', 'hi'), msg('assistant', [{ type: 'text', text: 'hello' }])]);
    const calls: string[] = [];
    const r = await runSummaries({ cfg, deps: { environment: ENV, fetchFn: fetchOk(calls) } });
    expect(r).toMatchObject({ considered: 1, skipped: 1, written: 0 });
    expect(calls).toHaveLength(0);
    expect((await query(`SELECT status FROM agent_summaries`)).rows).toEqual([{ status: 'skipped' }]);
  });

  it('leaves running sessions and Claude Code subagents alone', async () => {
    await session('running', convo(), { endedMinAgo: 2 });
    await session('sub', convo(), { parent: 'parent-1' });
    const calls: string[] = [];
    const r = await runSummaries({ cfg, deps: { environment: ENV, fetchFn: fetchOk(calls) } });
    expect(r.considered).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('counts a failure when every provider is down, writes nothing, and the next run retries', async () => {
    await session('s1', convo());
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const r = await runSummaries({ cfg, deps: { environment: ENV, fetchFn: down } });
    expect(r).toMatchObject({ considered: 1, failed: 1, written: 0 });
    expect((await query(`SELECT 1 FROM agent_summaries`)).rowCount).toBe(0);
    const retry = await runSummaries({ cfg, deps: { environment: ENV, fetchFn: fetchOk([]) } });
    expect(retry.written).toBe(1);
  });

  it('dry run writes nothing', async () => {
    await session('s1', convo());
    const r = await runSummaries({ cfg, dryRun: true, deps: { environment: ENV, fetchFn: fetchOk([]) } });
    expect(r.written).toBe(1);
    expect((await query(`SELECT 1 FROM agent_summaries`)).rowCount).toBe(0);
  });

  it('summarizes a Hermes session through the same path', async () => {
    const h = (role: string, extra: Record<string, unknown> = {}) => ({ id: n++, session_id: 'h1', role, content: null, tool_calls: null, tool_name: null, tool_call_id: null, reasoning: null, ...extra });
    await session('h1', [h('user', { content: 'Fix the discount bug on card t_ab12cd34' }), h('assistant', { content: 'On it.' }), h('assistant', { content: 'Done, tests pass.' }), h('user', { content: 'thanks' })], { source: 'hermes:builder' });
    const r = await runSummaries({ cfg, deps: { environment: ENV, fetchFn: fetchOk([]) } });
    expect(r.written).toBe(1);
    const { rows: [s] } = await query(`SELECT harness, profile FROM agent_summaries`);
    expect(s).toEqual({ harness: 'hermes', profile: 'builder' });
  });
});
