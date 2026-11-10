import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { relabelChannels } from '../src/archive/backfill.js';
import { sha256 } from '../src/archive/clean.js';
import * as archive from '../src/archive/store.js';
import type { SessionInput } from '../src/archive/types.js';
import { query, withTransaction } from '../src/db.js';
import { resetSettings } from '../src/settings.js';
import { syncUsage } from '../src/usage/sync.js';
import { ALL_MODULES, truncateAll } from './helpers.js';

// The channel label end to end: collectors write it, the column and the page read it, the backfill adds it to old rows.
const app = createApp({ modules: ALL_MODULES });
const line = (o: object) => JSON.stringify(o) + '\n';
const TAG = '<channel source="plugin:telegram:telegram" chat_id="12345" message_id="7" user="someone" user_id="12345" ts="2026-10-30T19:05:30.000Z">';
const CLEAR = '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>';
const user = (uuid: string, ts: string, content: string) => line({ type: 'user', uuid, timestamp: ts, sessionId: 'tg-1', message: { role: 'user', content } });
const assistant = (uuid: string, id: string, ts: string) => line({ type: 'assistant', uuid, timestamp: ts, sessionId: 'tg-1', entrypoint: 'cli',
  message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'filed' }], usage: { input_tokens: 5, output_tokens: 3 } } });
const sess = (over: Partial<SessionInput>): SessionInput => ({
  source: 'claude-code', host: 'mac', externalId: 's1', parentExternalId: null, project: 'p', title: null, model: null,
  startedAt: new Date('2026-10-30T19:00:00Z'), endedAt: new Date('2026-10-30T19:10:00Z'), messageCount: 1, inputTokens: null, outputTokens: null, costUsd: null, meta: {}, b2Path: null, ...over,
});

let root: string;
beforeEach(async () => {
  await truncateAll();
  root = mkdtempSync(join(tmpdir(), 'channel-'));
  writeFileSync(join(root, 'secondbrain.json'), JSON.stringify({ telegram: { bots: [
    { name: 'claude', agent: 'claude-code', username: 'examplebot' }, { name: 'hermes', agent: 'hermes', profile: 'main' }, { name: 'zen', agent: 'zen-agent', persona: 'sol' }] } }));
  process.env.SECONDBRAIN_SETTINGS = join(root, 'secondbrain.json');
  resetSettings();
});
afterEach(() => { delete process.env.SECONDBRAIN_SETTINGS; resetSettings(); });

describe('channel label from the collectors', () => {
  it('labels a Claude Code Telegram session from its first tagged prompt and keeps the label on later chunks', async () => {
    const proj = join(root, 'projects', '-home-me-vault');
    mkdirSync(proj, { recursive: true });
    const file = join(proj, 'tg-1.jsonl');
    writeFileSync(file, user('u1', '2026-10-30T19:00:06Z', CLEAR) + user('u2', '2026-10-30T19:05:31Z', `${TAG}\nfile a ticket please\n</channel>`) + assistant('a1', 'msg_1', '2026-10-30T19:05:40Z'));
    const paths = { claudeProjectsDir: join(root, 'projects'), runsDir: null, statuslineLog: null };
    await syncUsage(paths, 'droplet');
    const row = async () => (await query(`SELECT channel, meta, title FROM archive_sessions WHERE external_id = 'tg-1'`)).rows[0]!;
    expect(await row()).toMatchObject({ channel: 'telegram', meta: { channel: 'telegram', channel_handle: '@someone', channel_bot: 'claude', entrypoint: 'cli' } });
    expect(JSON.stringify((await row()).meta)).not.toContain('12345');
    // The next chunk has no tag: the label stays.
    writeFileSync(file, readFileSync(file, 'utf8') + user('u3', '2026-10-30T19:06:00Z', `${TAG}\nthanks\n</channel>`) + assistant('a2', 'msg_2', '2026-10-30T19:06:05Z'));
    await syncUsage(paths, 'droplet');
    expect((await row()).channel).toBe('telegram');
    const steps = (await query(`SELECT step, content_text FROM archive_messages ORDER BY seq`)).rows;
    expect(steps.map((s) => s.step)).toEqual(['meta', 'prompt', 'response', 'prompt', 'response']);
    expect(steps[1]!.content_text).toBe('file a ticket please');
    // The page: the /clear record is not the title, the chip says telegram, the facet counts it.
    const list = await request(app).get('/api/usage/agent-sessions?from=2026-10-30T00:00:00Z&to=2026-10-31T00:00:00Z').expect(200);
    expect(list.body.sessions[0]).toMatchObject({ channel: 'telegram', channel_bot: 'claude', first_prompt: 'file a ticket please',
      session_type: 'telegram', persona: 'claude', display_title: 'file a ticket please', title_source: 'prompt', context_tokens: 5 });
    const facets = await request(app).get('/api/usage/agent-sessions/facets?from=2026-10-30T00:00:00Z&to=2026-10-31T00:00:00Z').expect(200);
    expect(facets.body.facets.channel).toEqual([{ value: 'telegram', n: 1 }]);
    const none = await request(app).get('/api/usage/agent-sessions?from=2026-10-30T00:00:00Z&to=2026-10-31T00:00:00Z&channel=none').expect(200);
    expect(none.body.total).toBe(0);
    // usage_facts carries it to the token charts.
    expect((await query(`SELECT channel, count(*)::int n FROM usage_facts GROUP BY 1`)).rows).toEqual([{ channel: 'telegram', n: 2 }]);
  });

  it('never guesses between same-agent bots and honors only recorded matching identities', async () => {
    writeFileSync(join(root, 'secondbrain.json'), JSON.stringify({ telegram: { bots: [
      { name: 'first', agent: 'claude-code', username: 'firstbot', persona: 'first-persona' },
      { name: 'second', agent: 'claude-code', username: 'secondbot', persona: 'second-persona' },
      { name: 'other-runtime', agent: 'hermes', persona: 'other-persona' },
    ] } }));
    resetSettings();
    const dir = join(root, 'projects', '-srv-example');
    mkdirSync(dir, { recursive: true });
    const cases = [['ambiguous', ''], ['named', ' bot="second"'], ['username', ' bot="@secondbot"'],
      ['unknown', ' bot="not-configured"'], ['wrong-runtime', ' bot="other-runtime"']];
    for (const [id, hint] of cases) writeFileSync(join(dir, `${id}.jsonl`), line({ type: 'user', uuid: id, sessionId: id,
      timestamp: '2026-10-30T19:05:31Z', entrypoint: 'cli', message: { content: `<channel source="plugin:telegram:telegram"${hint}>\nInspect a synthetic deployment\n</channel>` } }));
    await syncUsage({ claudeProjectsDir: join(root, 'projects'), runsDir: null, statuslineLog: null }, 'mac');
    // Repair a formerly guessed identity when the next increment has no recorded bot hint.
    await query(`UPDATE archive_sessions SET meta = meta || '{"channel_bot":"first","channel_persona":"first-persona"}'::jsonb WHERE external_id='ambiguous'`);
    const ambiguous = join(dir, 'ambiguous.jsonl');
    writeFileSync(ambiguous, readFileSync(ambiguous, 'utf8') + line({ type: 'user', uuid: 'next', sessionId: 'ambiguous',
      timestamp: '2026-10-30T19:06:31Z', entrypoint: 'cli', message: { content: '<channel source="plugin:telegram:telegram">\nInspect again\n</channel>' } }));
    await syncUsage({ claudeProjectsDir: join(root, 'projects'), runsDir: null, statuslineLog: null }, 'mac');
    const rows = (await query(`SELECT external_id, meta ->> 'channel_bot' bot, meta ->> 'channel_persona' persona FROM archive_sessions ORDER BY external_id`)).rows;
    expect(rows).toEqual([
      { external_id: 'ambiguous', bot: null, persona: null },
      { external_id: 'named', bot: 'second', persona: 'second-persona' },
      { external_id: 'unknown', bot: null, persona: null },
      { external_id: 'username', bot: 'second', persona: 'second-persona' },
      { external_id: 'wrong-runtime', bot: null, persona: null },
    ]);
    const list = await request(app).get('/api/usage/agent-sessions').query({ from: '2026-10-30T00:00:00Z', to: '2026-10-31T00:00:00Z', type: 'telegram' }).expect(200);
    expect(list.body.sessions.find((r: { external_id: string }) => r.external_id === 'ambiguous')).toMatchObject({ channel_bot: null, persona: null });
    expect(list.body.sessions.find((r: { external_id: string }) => r.external_id === 'named')).toMatchObject({ channel_bot: 'second', persona: 'second-persona' });
  });

  it('labels a zen-agent run from the meta line a resumed run appended', async () => {
    const zen = join(root, 'zen');
    mkdirSync(zen);
    const id = 'sol-20261026-173614-abcd';
    writeFileSync(join(zen, `${id}.jsonl`),
      line({ type: 'meta', version: 1, id, at: '2026-10-26T17:36:14.902Z', persona: 'sol', model: 'openrouter/x/y', dispatch: {} }) +
      line({ type: 'message', at: '2026-10-26T17:36:15.000Z', message: { role: 'user', content: 'update the stand-up style guide', timestamp: '2026-10-26T17:36:15.000Z' } }) +
      line({ type: 'end', at: '2026-10-26T17:37:00.000Z', stopped: 'done', turns: 1 }) +
      line({ type: 'meta', version: 1, id, at: '2026-10-28T08:41:57.485Z', persona: 'sol', model: 'openrouter/x/y', resumed: id,
        dispatch: { reasons: [{ reason: 'telegram', ref: '9' }], work_type: 'telegram', channel: 'telegram', bot: 'zen' } }) +
      line({ type: 'message', at: '2026-10-28T08:41:58.000Z', message: { role: 'user', content: 'and the reel skill', timestamp: '2026-10-28T08:41:58.000Z' } }) +
      line({ type: 'end', at: '2026-10-28T08:42:30.000Z', stopped: 'done', turns: 1 }));
    await syncUsage({ claudeProjectsDir: join(root, 'none'), runsDir: null, statuslineLog: null, zenSessionsDir: zen }, 'droplet');
    expect((await query(`SELECT channel, meta ->> 'channel_bot' bot, meta ->> 'channel_persona' persona FROM archive_sessions`)).rows)
      .toEqual([{ channel: 'telegram', bot: 'zen', persona: 'sol' }]);
    expect((await query(`SELECT work_type, reasons FROM usage_runs`)).rows[0]).toMatchObject({ work_type: 'telegram', reasons: [{ reason: 'telegram', ref: '9' }] });
  });

  it('merges meta for incremental sessions and replaces it for whole-row ones', async () => {
    await withTransaction(async (tx) => {
      await archive.upsertSession(tx, sess({ messageCount: null, meta: { channel: 'telegram' } }));
      await archive.upsertSession(tx, sess({ messageCount: null, meta: {} }));
      await archive.upsertSession(tx, sess({ externalId: 'h1', source: 'hermes', meta: { source: 'telegram', channel: 'telegram' } }));
      await archive.upsertSession(tx, sess({ externalId: 'h1', source: 'hermes', meta: { source: 'cron' } }));
    });
    const rows = (await query(`SELECT external_id, channel FROM archive_sessions ORDER BY 1`)).rows;
    expect(rows).toEqual([{ external_id: 'h1', channel: null }, { external_id: 's1', channel: 'telegram' }]);
  });
});

describe('relabelChannels', () => {
  it('labels old Telegram sessions on every harness, unwraps their prompts and reclassifies slash commands', async () => {
    await withTransaction(async (tx) => {
      const s = await archive.upsertSession(tx, sess({ externalId: 'old-tg' }));
      await archive.upsertMessages(tx, s.id, [
        { seq: 1, externalId: 'u1', parentExternalId: null, role: 'user', kind: 'user', ts: new Date('2026-10-12T09:00:00Z'), contentText: CLEAR,
          raw: { type: 'user', message: { role: 'user', content: 'x' } }, rawSha: sha256('1'), isSidechain: false },
        { seq: 2, externalId: 'u2', parentExternalId: null, role: 'user', kind: 'user', ts: new Date('2026-10-12T09:01:00Z'), contentText: `${TAG}\nsave this gear\n</channel>`,
          raw: { type: 'user', message: { role: 'user', content: 'x' } }, rawSha: sha256('2'), isSidechain: false },
      ]);
      await archive.upsertSession(tx, sess({ externalId: 'typed' }));
      await archive.upsertSession(tx, sess({ externalId: 'h-tg', source: 'hermes', meta: { source: 'telegram', profile: 'main', chat_type: 'dm' } }));
      await archive.upsertSession(tx, sess({ externalId: 'h-cron', source: 'hermes', meta: { source: 'cron', profile: 'main' } }));
      await archive.upsertSession(tx, sess({ externalId: 'z-tg', source: 'zen-agent', meta: { persona: 'sol', dispatch: { work_type: 'telegram', reasons: '[{"reason":"telegram","ref":"9"}]' } } }));
      await archive.upsertSession(tx, sess({ externalId: 'z-card', source: 'zen-agent', meta: { persona: 'sol', dispatch: { reasons: '[{"reason":"task","ref":"t_1"}]' } } }));
    });
    // The first message was stored as a prompt (the parser classified it before this version).
    await query(`UPDATE archive_messages SET step = 'prompt' WHERE external_id = 'u1'`);
    const r = await relabelChannels({ batch: 10, log: () => {} });
    expect(r).toEqual({ sessions: 3, messages: 1, commands: 1 });
    const rows = (await query(`SELECT external_id, channel, meta ->> 'channel_bot' bot FROM archive_sessions ORDER BY 1`)).rows;
    expect(rows).toEqual([
      { external_id: 'h-cron', channel: null, bot: null }, { external_id: 'h-tg', channel: 'telegram', bot: 'hermes' },
      { external_id: 'old-tg', channel: 'telegram', bot: 'claude' }, { external_id: 'typed', channel: null, bot: null },
      { external_id: 'z-card', channel: null, bot: null }, { external_id: 'z-tg', channel: 'telegram', bot: 'zen' },
    ]);
    const msgs = (await query(`SELECT step, content_text FROM archive_messages ORDER BY seq`)).rows;
    expect(msgs).toEqual([{ step: 'meta', content_text: CLEAR }, { step: 'prompt', content_text: 'save this gear' }]);
    expect(await relabelChannels({ batch: 10, log: () => {} })).toEqual({ sessions: 0, messages: 0, commands: 0 });
  });
});
