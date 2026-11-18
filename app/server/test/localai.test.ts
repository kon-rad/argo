import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query } from '../src/db.js';
import { pullLocalAi, type ExportPage, type Fetcher } from '../src/localai/pull.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

const HOST = 'home-box';
const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);
const RUN = '06558481-c3ca-459e-9555-4b58e538678e';

function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN, started_at: '2026-01-02T03:00:00Z', ended_at: '2026-01-02T03:00:05Z', state: 'ok', service: 'ollama',
    route: '/v1/chat/completions', method: 'POST', http_status: 200, model: 'qwen-test', model_digest: 'd1', stream: true,
    options: { temperature: 0.2 }, request_meta: { messages: '<2 messages in texts>' }, tool_names: ['read_file'],
    message_count: 2, image_count: null, caller_label: 'hermes/writer', caller_node: 'laptop', caller_ip: '192.0.2.5',
    caller_pid: 42, caller_process: 'python3', caller_cmd: 'secret --flag', user_agent: 'OpenAI/Python',
    prompt_tokens: 1000, cached_tokens: 200, output_tokens: 250, embed_count: null, ttft_ms: 300, total_ms: 5000,
    load_ms: 1, prompt_eval_ms: 400, eval_ms: 4500, prompt_tps: 2500, output_tps: 55.5, done_reason: 'stop',
    cold_start: false, input_chars: 4000, output_chars: 900, audio_seconds: null, voice: null, request_bytes: 5000,
    response_bytes: 2000, gpu_avg_w: 30, package_avg_w: 40, energy_j: 180, mem_free_pct_start: 50, error: null,
    change_seq: 10, ...over,
  };
}

/** A fake export: per table, the rows it holds; serves them by change_seq after the cursor, `limit` at a time. */
function fakeHost(tables: Record<string, Record<string, unknown>[]>, calls: string[] = []): Fetcher {
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    const t = u.searchParams.get('table')!;
    const after = Number(u.searchParams.get('after'));
    const limit = Number(u.searchParams.get('limit'));
    const all = (tables[t] ?? []).filter((r) => Number(r.change_seq) > after).sort((a, b) => Number(a.change_seq) - Number(b.change_seq));
    const rows = all.slice(0, limit);
    const page: ExportPage = { rows, next_after: rows.length ? Number(rows[rows.length - 1]!.change_seq) : after, more: all.length > limit };
    return page;
  };
}

const sample = () => ({
  ai_runs: [run()],
  ai_texts: [
    { sha256: SHA, content: 'You are a writer.', chars: 17, first_seen: '2026-01-02T03:00:00Z', change_seq: 8 },
    { sha256: SHA2, content: 'Here is the draft.', chars: 18, first_seen: '2026-01-02T03:00:05Z', change_seq: 9 },
  ],
  ai_run_texts: [
    { run_id: RUN, seq: 0, role: 'system', kind: 'message', text_sha256: SHA, change_seq: 11 },
    { run_id: RUN, seq: 1, role: 'assistant', kind: 'response', text_sha256: SHA2, change_seq: 12 },
  ],
  models: [{ name: 'qwen-test', digest: 'd1', family: 'qwen', param_size: '35B', quant: 'q4', format: 'gguf', size_bytes: 24e9,
    modified_at: '2026-01-01T00:00:00Z', first_seen: '2026-01-01T00:00:00Z', last_seen: '2026-01-02T00:00:00Z', removed_at: null, change_seq: 3 }],
  model_loads: [{ id: 1, model: 'qwen-test', digest: 'd1', loaded_at: '2026-01-02T02:59:00Z', unloaded_at: null, size_bytes: 24e9,
    size_vram: 24e9, context_length: 65536, runner: 'mlx', quant: 'q4', change_seq: 4 }],
});

afterAll(async () => {
  await truncateAll();
  await query(`DELETE FROM usage_hosts WHERE slug = $1`, [HOST]);
});

beforeEach(async () => {
  await truncateAll();
  await query(`INSERT INTO usage_hosts (slug, display, kind) VALUES ($1, 'Home model box', 'server') ON CONFLICT DO NOTHING`, [HOST]);
});

describe('local-ai-pull', () => {
  it('copies every table, keeps caller IP, PID and command on the host, and advances the cursors', async () => {
    const results = await pullLocalAi({ host: HOST, baseUrl: 'http://192.0.2.10:8090/', fetcher: fakeHost(sample()) });
    expect(results.filter((r) => r.error)).toEqual([]);
    expect(Object.fromEntries(results.map((r) => [r.table, r.rows]))).toEqual({ models: 1, model_loads: 1, ai_texts: 2, ai_runs: 1, ai_run_texts: 2 });
    const r = (await query(`SELECT * FROM local_ai_runs`)).rows[0]!;
    expect(r).toMatchObject({ host: HOST, model: 'qwen-test', caller_label: 'hermes/writer', prompt_tokens: 1000, output_tokens: 250, source_seq: 10 });
    expect(r.options).toEqual({ temperature: 0.2 });
    expect(r).not.toHaveProperty('caller_ip');
    expect(r).not.toHaveProperty('caller_cmd');
    const cur = (await query(`SELECT tbl, after_seq, rows_total FROM local_ai_cursors WHERE host = $1 ORDER BY tbl`, [HOST])).rows;
    expect(cur).toContainEqual({ tbl: 'ai_run_texts', after_seq: 12, rows_total: 2 });
  });

  it('is idempotent and takes an update to a row as a newer seq', async () => {
    const tables = sample();
    await pullLocalAi({ host: HOST, baseUrl: 'http://x', fetcher: fakeHost(tables) });
    const calls: string[] = [];
    let again = await pullLocalAi({ host: HOST, baseUrl: 'http://x', fetcher: fakeHost(tables, calls) });
    expect(again.reduce((n, r) => n + r.rows, 0)).toBe(0);
    expect(calls.find((c) => c.includes('table=ai_runs'))).toContain('after=10');
    // The run was still running on the host and has now finished: same id, a higher seq.
    tables.ai_runs = [run({ state: 'error', error: 'upstream unreachable', change_seq: 20 })];
    again = await pullLocalAi({ host: HOST, baseUrl: 'http://x', fetcher: fakeHost(tables) });
    expect(again.find((r) => r.table === 'ai_runs')!.rows).toBe(1);
    const rows = (await query(`SELECT state, error, source_seq FROM local_ai_runs`)).rows;
    expect(rows).toEqual([{ state: 'error', error: 'upstream unreachable', source_seq: 20 }]);
  });

  it('pages through more rows than one page holds', async () => {
    const tables = sample();
    tables.ai_runs = Array.from({ length: 7 }, (_, i) => run({ id: `00000000-0000-4000-8000-00000000000${i}`, change_seq: 100 + i }));
    const calls: string[] = [];
    const res = await pullLocalAi({ host: HOST, baseUrl: 'http://x', fetcher: fakeHost(tables, calls), pageSize: 3 });
    expect(res.find((r) => r.table === 'ai_runs')).toMatchObject({ rows: 7, after: 106 });
    expect(calls.filter((c) => c.includes('table=ai_runs')).length).toBe(3);
  });

  it('records the host being down per table and keeps the cursor', async () => {
    await pullLocalAi({ host: HOST, baseUrl: 'http://x', fetcher: fakeHost(sample()) });
    const down: Fetcher = async () => { throw new Error('connect ECONNREFUSED'); };
    const res = await pullLocalAi({ host: HOST, baseUrl: 'http://x', fetcher: down });
    expect(res.every((r) => r.error?.includes('ECONNREFUSED'))).toBe(true);
    const cur = (await query(`SELECT after_seq, last_error FROM local_ai_cursors WHERE host = $1 AND tbl = 'ai_runs'`, [HOST])).rows[0]!;
    expect(cur).toEqual({ after_seq: 10, last_error: 'connect ECONNREFUSED' });
  });

  it('refuses a host that is not registered', async () => {
    await expect(pullLocalAi({ host: 'nobody', baseUrl: 'http://x', fetcher: fakeHost({}) })).rejects.toThrow(/usage_hosts/);
  });
});

describe('/api/local-ai', () => {
  const app = () => createApp({ modules: ALL_MODULES });

  it('summarises tokens, speed and energy by model and caller, and serves one run with its texts', async () => {
    await pullLocalAi({ host: HOST, baseUrl: 'http://x', fetcher: fakeHost(sample()) });
    const s = await request(app()).get('/api/local-ai/summary').query({ from: '2026-01-02T00:00:00Z', to: '2026-01-03T00:00:00Z', bucket: 'hour', tz: 'UTC' });
    expect(s.status).toBe(200);
    expect(s.body.total).toMatchObject({ runs: 1, errors: 0, prompt: 1000, cached: 200, output: 250, avg_output_tps: 55.5, energy_wh: 0.05 });
    expect(s.body.models).toEqual([expect.objectContaining({ host: HOST, model: 'qwen-test', runs: 1, output: 250 })]);
    expect(s.body.callers).toEqual([expect.objectContaining({ caller: 'hermes/writer', runs: 1 })]);
    expect(s.body.series).toEqual([expect.objectContaining({ key: 'hermes/writer', prompt: 1000, output: 250 })]);
    expect(s.body.hosts[0]).toMatchObject({ host: HOST, display: 'Home model box', error: null });

    const list = await request(app()).get('/api/local-ai/runs').query({ from: '2026-01-02T00:00:00Z', to: '2026-01-03T00:00:00Z', caller: 'hermes/writer' });
    expect(list.body.runs).toHaveLength(1);
    const one = await request(app()).get(`/api/local-ai/runs/${HOST}/${RUN}`);
    expect(one.status).toBe(200);
    expect(one.body.texts.map((t: { content: string }) => t.content)).toEqual(['You are a writer.', 'Here is the draft.']);
    expect((await request(app()).get(`/api/local-ai/runs/${HOST}/00000000-0000-4000-8000-000000000999`)).status).toBe(404);
  });

  it('is not mounted when the module is off', async () => {
    const res = await request(createApp({ modules: new Set(['usage'] as const) })).get('/api/local-ai/summary');
    expect(res.status).toBe(404);
  });
});
