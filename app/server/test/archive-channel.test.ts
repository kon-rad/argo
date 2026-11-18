import { describe, expect, it } from 'vitest';
import { hermesChannel, isLocalCommandText, parseChannelTag, stripChannelTag, zenChannel } from '../src/archive/channel.js';
import { parseClaudeJsonl } from '../src/archive/claude.js';
import { expandSteps, stepFields } from '../src/archive/steps.js';

// A Claude Code channel plugin wraps each incoming message like this (ids are made up).
const TAG = '<channel source="plugin:telegram:telegram" chat_id="12345" message_id="502" user="someone" user_id="12345" ts="2026-10-30T19:05:30.000Z">';
const TELEGRAM = `${TAG}\nlets create a ticket about jev models\n</channel>`;
const CLEAR = '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>';
const CAVEAT = '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request.</local-command-caveat>';
const L = (o: unknown) => JSON.stringify(o) + '\n';
const user = (uuid: string, content: unknown) => ({ type: 'user', uuid, timestamp: '2026-10-30T19:00:00.000Z', message: { role: 'user', content } });

describe('channel tags', () => {
  it('reads the channel and the handle from the tag, never the ids', () => {
    expect(parseChannelTag(TELEGRAM)).toEqual({ channel: 'telegram', handle: '@someone' });
    expect(JSON.stringify(parseChannelTag(TELEGRAM))).not.toContain('12345');
    expect(parseChannelTag('plain prompt')).toBeNull();
    expect(parseChannelTag('<channel source="plugin:slack:slack" user="x">hi</channel>')).toBeNull();
    expect(parseChannelTag('<channel source="plugin:telegram:telegram">no user</channel>')).toEqual({ channel: 'telegram', handle: null });
  });

  it('strips the wrapper and leaves typed prompts alone', () => {
    expect(stripChannelTag(TELEGRAM)).toBe('lets create a ticket about jev models');
    expect(stripChannelTag('fix the page')).toBe('fix the page');
    expect(stripChannelTag(`${TAG}\nno closing tag`)).toBe('no closing tag');
  });

  it('knows the slash command records', () => {
    expect(isLocalCommandText(CLEAR)).toBe(true);
    expect(isLocalCommandText(CAVEAT)).toBe(true);
    expect(isLocalCommandText('<local-command-stdout>ok</local-command-stdout>')).toBe(true);
    expect(isLocalCommandText(TELEGRAM)).toBe(false);
    expect(isLocalCommandText('run /clear for me')).toBe(false);
  });

  it('maps Hermes sources and zen dispatch labels', () => {
    expect(hermesChannel('telegram')).toBe('telegram');
    expect(hermesChannel('api_server')).toBe('web');
    expect(hermesChannel('cron')).toBeNull();
    expect(zenChannel({ channel: 'telegram' }, [])).toBe('telegram');
    expect(zenChannel({}, [{ reason: 'telegram' }])).toBe('telegram');
    expect(zenChannel({ channel: 'carrier-pigeon' }, [{ reason: 'task' }])).toBeNull();
  });
});

describe('Claude Code transcripts from a channel', () => {
  it('labels the chunk and stores the prompt as the person wrote it', () => {
    const c = parseClaudeJsonl(Buffer.from(L(user('u1', CLEAR)) + L(user('u2', TELEGRAM)) + L(user('u3', [{ type: 'text', text: TELEGRAM }]))), 0);
    expect(c.channel).toEqual({ channel: 'telegram', handle: '@someone' });
    expect(c.messages[1]!.contentText).toBe('lets create a ticket about jev models');
    expect(c.messages[2]!.contentText).toBe('lets create a ticket about jev models');
    expect(JSON.stringify(c.messages[1]!.raw)).toContain('<channel source');   // the record itself is kept whole
    expect(parseClaudeJsonl(Buffer.from(L(user('u1', 'typed'))), 0).channel).toBeNull();
  });

  it('classifies slash commands as meta steps and shows channel prompts unwrapped', () => {
    expect(stepFields(user('u1', CLEAR)).step).toBe('meta');
    expect(stepFields(user('u1', CAVEAT)).step).toBe('meta');
    expect(stepFields(user('u1', [{ type: 'text', text: CLEAR }])).step).toBe('meta');
    expect(stepFields(user('u2', TELEGRAM)).step).toBe('prompt');
    const parts = expandSteps({ id: 1, role: 'user', kind: 'user', ts: null, raw: user('u2', [{ type: 'text', text: TELEGRAM }]), text: '' });
    expect(parts).toEqual([{ key: '1', step: 'prompt', text: 'lets create a ticket about jev models', toolName: null, toolCallId: null, isError: null }]);
    const cmd = expandSteps({ id: 2, role: 'user', kind: 'user', ts: null, raw: user('u1', [{ type: 'text', text: CLEAR }]), text: '' });
    expect(cmd[0]!.step).toBe('meta');
  });
});
