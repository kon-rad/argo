import request from 'supertest';
import { beforeEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { query, withTransaction } from '../src/db.js';
import { ingestBatch } from '../src/ingest/batch.js';
import { importLines } from '../src/usage/importer.js';
import { replayProvenance } from '../src/usage/provenance.js';
import { ALL_MODULES, truncateAll } from './helpers.js';
const app = createApp({ modules: ALL_MODULES });
const host = 'laptop-a', task = 't_1234abcd', at = new Date().toISOString();
const L = (v: unknown) => JSON.stringify(v);
const session = (id: string, text = 'hello') => ({ t: 'codex', text: [
  { type: 'session_meta', timestamp: at, payload: { id, source: 'cli' } },
  { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: text } },
].map(L).join('\n') + '\n' });
const launch = (runId: string, sessionId: string | null, overrides = {}) => ({ t: 'launch', launch: {
  v: 1, runId, source: 'codex', runtime: 'codex', sessionId, entrypoint: 'exec', trigger: 'board',
  channel: null, persona: 'ada', personaOrigin: 'dispatcher', taskIds: [task], ...overrides,
} });
async function push(...lines: unknown[]) { expect((await importLines(lines.map(L), host)).errors).toEqual([]); }
async function rows() { return (await request(app).get('/api/usage/agent-sessions').expect(200)).body.sessions; }
beforeEach(async () => {
  await truncateAll();
  await query(`INSERT INTO org_agents (name,runtime,role,org_version) VALUES ('ada','codex','Engineer','v')`);
  await query(`INSERT INTO boards (slug,name) VALUES ('demo','Demo')`);
  await query(`INSERT INTO cards (id,board_slug,title,status,created_by) VALUES ($1,'demo','Example','ready','ada'), ('t_abcdef12','demo','Other','ready','ada')`, [task]);
});
it('persists prelaunch, binds once, retries and keeps resumed tasks without wakes', async () => {
  await push(launch('run-1', null));
  expect((await query('SELECT session_id FROM usage_launches')).rows).toEqual([{ session_id: null }]);
  await push(session('sid'), launch('run-1', 'sid'), launch('run-1', 'sid'), launch('run-2', 'sid', { taskIds: ['t_abcdef12'], trigger: 'cron', channel: 'telegram' }));
  const [s] = await rows();
  expect(s).toMatchObject({ task_ids: [task, 't_abcdef12'], persona: 'ada', runtime_entrypoint: 'exec', outer_trigger: 'cron', channel: null });
  expect(s.launches).toHaveLength(2);
  expect((await query('SELECT count(*)::int n FROM usage_runs')).rows[0].n).toBe(0);
  expect((await query('SELECT count(*)::int n FROM org_wakeups')).rows[0].n).toBe(0);
  await expect(push(launch('run-1', 'wrong'))).rejects.toThrow(/conflict/);
  const detail = (await request(app).get(`/api/usage/agent-sessions/${s.host}/${s.external_id}?source=${s.source}`).expect(200)).body.session;
  expect(detail.persona).toBe(s.persona);
  expect(detail.task_ids).toEqual(s.task_ids);
  expect((await request(app).get('/api/usage/agent-sessions?persona=ada').expect(200)).body.sessions).toHaveLength(1);
  expect((await request(app).get('/api/usage/agent-sessions/facets').expect(200)).body.facets.persona).toContainEqual({ value: 'ada', n: 1 });
});
it('does not promote mentions, reply fragments, unknown personas or missing metadata', async () => {
  await push(session('owner', 'You are **ada**, Engineer.\nLook at t_1234abcd'), session('quote', '> Board card t_1234abcd: example\n[Replying to: Telegram]'),
    session('unknown'), launch('unknown-run', 'unknown', { persona: 'stranger', taskIds: [], trigger: 'telegram', channel: 'telegram' }), session('absent'));
  const ss = await rows();
  expect(ss.every((s: any) => s.task_ids.length === 0)).toBe(true);
  expect(ss.find((s: any) => s.external_id === 'quote')).toMatchObject({ channel: null, outer_trigger: null });
  expect(ss.find((s: any) => s.external_id === 'unknown')).toMatchObject({ persona: null, persona_status: 'unknown' });
  expect(ss.find((s: any) => s.external_id === 'absent')).toMatchObject({ persona: null, persona_status: 'absent' });
});
it('scoped replay is dry by default, validates headings and never changes messages or calls', async () => {
  const historical = session('historical', 'Board card t_1234abcd: Example\nWork on this card.');
  historical.text += L({type:'event_msg',timestamp:at,payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,output_tokens:10}}}})+'\n';
  await push(historical, session('quote', 'Discuss Board card t_1234abcd: Example'));
  const ids = (await rows()).map((s: any) => s.id);
  const before = (await query('SELECT * FROM archive_messages ORDER BY id')).rows;
  const callsBefore = (await query('SELECT * FROM usage_calls ORDER BY id')).rows;
  expect(callsBefore).toHaveLength(1);
  await withTransaction(async tx => { expect((await replayProvenance(tx, ids, true)).linked).toBe(1); });
  expect((await rows()).every((s: any) => s.task_ids.length === 0)).toBe(true);
  await withTransaction(tx => replayProvenance(tx, ids, false));
  expect((await rows()).find((s: any) => s.external_id === 'historical').task_ids).toEqual([task]);
  await withTransaction(async tx => { expect((await replayProvenance(tx, ids, false)).changed).toBe(0); });
  expect((await query('SELECT * FROM archive_messages ORDER BY id')).rows).toEqual(before);
  expect((await query('SELECT * FROM usage_calls ORDER BY id')).rows).toEqual(callsBefore);
});

it('freezes unknown launch and native personas instead of assigning a later roster member', async () => {
  await push(session('native-unknown','You are **stranger**, Engineer.'), session('launch-unknown'),
    launch('unknown','launch-unknown',{persona:'stranger',taskIds:[]}));
  await query(`INSERT INTO org_agents (name,runtime,role,org_version) VALUES ('stranger','codex','Engineer','v')`);
  await push(session('native-unknown','You are **stranger**, Engineer.'), launch('unknown','launch-unknown',{persona:'stranger',taskIds:[]}));
  for (const s of await rows()) expect(s).toMatchObject({ persona:null, persona_status:'unknown' });
});
it('accepts the same immutable envelope through the authenticated device batch transport', async () => {
  await push(session('device-session'));
  const d = await query(`INSERT INTO ingest_devices (host,token_hash) VALUES ($1,'fake-hash') RETURNING id`,[host]);
  const batch = {v:1 as const, ledgerId:'device-ledger',bundle:'test',fromSeq:1,toSeq:1,
    rows:[{seq:1,kind:'launch' as const,key:'codex|device-run',data:launch('device-run','device-session').launch}]};
  await ingestBatch({id:d.rows[0].id,host},batch);
  await ingestBatch({id:d.rows[0].id,host},batch);
  expect((await rows())[0].task_ids).toEqual([task]);
  expect((await query('SELECT count(*)::int n FROM usage_launches')).rows[0].n).toBe(1);
});
it('keeps owner chat tokens in by-bot totals while all wake counts stay zero', async () => {
  const owner = session('owner','You are **ada**, Engineer.');
  owner.text += L({type:'event_msg',timestamp:at,payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,output_tokens:10}}}})+'\n';
  await push(owner);
  expect((await rows())[0].persona).toBe('ada');
  expect((await query('SELECT agent_name,input,output,surface FROM usage_facts')).rows).toEqual([{agent_name:'ada',input:100,output:10,surface:'owner-chat'}]);
  expect((await query('SELECT count(*)::int n FROM usage_runs')).rows[0].n).toBe(0);
  expect((await query('SELECT count(*)::int n FROM org_wakeups')).rows[0].n).toBe(0);
});
it('does not bind another host or runtime with the same native session ID', async () => {
  await push(session('same-id'),launch('correct','same-id'));
  await importLines([L(session('same-id'))],'laptop-b');
  const ss=await rows();
  expect(ss.find((s:any)=>s.host==='laptop-b').task_ids).toEqual([]);
  await push(launch('other-runtime','same-id',{source:'claude-code',runtime:'claude-code',taskIds:['t_abcdef12']}));
  expect((await rows()).find((s:any)=>s.host===host).task_ids).toEqual([task]);
});

it('keeps recorded run identity and surface when newer launch evidence names an unknown persona', async () => {
  const native = session('recorded', 'You are **ada**, Engineer.');
  native.text += L({ type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } } } }) + '\n';
  await push(native, launch('new-launch', 'recorded', { persona: 'stranger', taskIds: [] }));
  // Historical runs retain their recorded identity even when that identity is absent from today's roster.
  await query(`INSERT INTO usage_runs (host,run_id,session_id,log_path,runtime,agent_name)
    VALUES ($1,'recorded-run','recorded','dispatch:recorded-run','codex','legacy-bot')`, [host]);
  await query(`UPDATE usage_calls SET run_id='recorded-run' WHERE host=$1 AND session_external_id='recorded'`, [host]);
  const before = (await query('SELECT * FROM usage_calls ORDER BY id')).rows;
  const messages = (await query('SELECT * FROM archive_messages ORDER BY id')).rows;
  expect((await rows())[0]).toMatchObject({ persona: 'legacy-bot', persona_status: 'unknown' });
  expect((await query('SELECT agent_name,input,output,surface FROM usage_facts')).rows)
    .toEqual([{ agent_name: 'legacy-bot', input: 100, output: 10, surface: 'bot' }]);
  await push(launch('new-launch', 'recorded', { persona: 'stranger', taskIds: [] }));
  expect((await query('SELECT * FROM usage_calls ORDER BY id')).rows).toEqual(before);
  expect((await query('SELECT * FROM archive_messages ORDER BY id')).rows).toEqual(messages);
  expect((await query('SELECT count(*)::int n FROM org_wakeups')).rows[0].n).toBe(0);
  expect((await request(app).get('/api/usage/agent-sessions?persona=legacy-bot').expect(200)).body.sessions).toHaveLength(1);
});

it('does not mask a validated native persona with an unknown launch candidate', async () => {
  await push(session('known-native', 'You are **ada**, Engineer.'),
    launch('unknown-overlay', 'known-native', { persona: 'stranger', taskIds: [] }));
  expect((await rows())[0]).toMatchObject({ persona: 'ada', persona_status: 'known' });
  expect((await query('SELECT resolved_persona,persona_status FROM usage_launches')).rows)
    .toEqual([{ resolved_persona: null, persona_status: 'unknown' }]);
});

it('keeps a configured channel persona independently of roster bot validation in every reader', async () => {
  const owner = session('channel-owner');
  owner.text += L({ type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } } } }) + '\n';
  await push(owner);
  await query(`UPDATE archive_sessions SET meta=meta || '{"channel":"telegram","channel_bot":"transport","channel_persona":"configured-persona"}'::jsonb WHERE external_id='channel-owner'`);
  const [s] = await rows();
  expect(s).toMatchObject({ persona: 'configured-persona', persona_status: 'unknown', channel_bot: 'transport' });
  const detail = (await request(app).get(`/api/usage/agent-sessions/${host}/channel-owner?source=codex`).expect(200)).body.session;
  expect(detail.persona).toBe('configured-persona');
  expect((await query("SELECT bot FROM archive_sessions WHERE external_id='channel-owner'")).rows).toEqual([{ bot: null }]);
  expect((await request(app).get('/api/usage/agent-sessions?persona=configured-persona').expect(200)).body.sessions).toHaveLength(1);
  expect((await request(app).get('/api/usage/agent-sessions/facets').expect(200)).body.facets.persona)
    .toContainEqual({ value: 'configured-persona', n: 1 });
  expect((await query('SELECT agent_name,surface FROM usage_facts')).rows)
    .toEqual([{ agent_name: 'configured-persona', surface: 'owner-chat' }]);
  expect((await query('SELECT count(*)::int n FROM org_wakeups')).rows[0].n).toBe(0);
});

it('enforces launch and task evidence identity with foreign keys and a writable evidence table', async () => {
  await push(session('relations'), launch('relations-run', 'relations'));
  const [s] = await rows();
  const insert = `INSERT INTO archive_session_tasks (session_id,task_id,evidence_id,provenance,confidence,reason)
    VALUES ($1,$2,'manual-evidence','board-envelope-v1','validated-envelope','synthetic test')`;
  await query(insert, [s.id, task]);
  await expect(query(insert, [s.id, task])).rejects.toThrow(/duplicate key|unique/);
  await expect(query(insert, [s.id, 't_00000000'])).rejects.toThrow(/foreign key/);
  await expect(query(insert, [-1, task])).rejects.toThrow(/foreign key/);
  const links = (await query('SELECT provenance FROM usage_session_tasks WHERE session_id=$1 ORDER BY provenance', [s.id])).rows;
  expect(links).toEqual([{ provenance: 'board-envelope-v1' }, { provenance: 'launch-v1' }]);
  await expect(query(`INSERT INTO usage_launches SELECT * FROM usage_launches`)).rejects.toThrow(/duplicate key|unique/);
  await query('DELETE FROM archive_sessions WHERE id=$1', [s.id]);
  expect((await query('SELECT count(*)::int n FROM archive_session_tasks')).rows[0].n).toBe(0);
});


it('acknowledges trusted launches alongside quarantined fragments and source health', async () => {
  const path = '/synthetic/codex';
  const health = { v: 1, collectorInstance: 'merge-fixture', runtime: 'codex', path,
    attemptSeq: 1, collectorVersion: 'fixture', startedAt: at, endedAt: at, outcome: 'ok',
    observedAt: at, importedAt: at, backlog: 0, oldestPendingAt: null,
    rejected: 0, quarantined: 0, reason: null, capabilities: ['heartbeat'] };
  const imported = await importLines([
    L({ ...session('mixed-session'), path: path + '/session.jsonl' }),
    L(launch('mixed-run', 'mixed-session')),
    L({ t: 'launch', launch: { v: 99 } }),
    L({ t: 'health', health }),
  ], host, { quarantine: true });
  expect(imported.accepted).toEqual([1, 2, 4]);
  expect(imported.rejected).toEqual([3]);
  expect(imported.quarantined).toEqual([3]);
  expect((await rows())[0].task_ids).toEqual([task]);
  expect((await query('SELECT count(*)::int n FROM usage_launches')).rows[0].n).toBe(1);
  expect((await query('SELECT count(*)::int n FROM usage_import_quarantine')).rows[0].n).toBe(1);
  const stream = (await query('SELECT observed_at, imported_at, outcome FROM collection_streams WHERE host=$1 AND path=$2', [host, path])).rows[0];
  expect(stream.observed_at.toISOString()).toBe(at);
  expect(stream.imported_at.toISOString()).toBe(at);
  expect(stream.outcome).toBe('retry');
});
