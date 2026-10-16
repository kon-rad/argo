import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { scanVault } from '../src/connectors/vault/scan.js';
import { MAX_SPEECH_CHARS, readVoiceSettings, speechText } from '../src/voice.js';
import { ALL_MODULES, truncateAll, vaultSourceId } from './helpers.js';

describe('speechText', () => {
  it('keeps the words and drops frontmatter, code, URLs and markup', () => {
    const md = [
      '---',
      'title: Plan',
      '---',
      '# Local TTS',
      '',
      'Read **this** and see [the docs](https://example.com) or [[notes/beta|Beta]] and [[gamma]].',
      '',
      '```bash',
      'rm -rf /',
      '```',
      '',
      '- first item',
      '- [x] done item',
      '1. numbered',
      '',
      '| Model | Size |',
      '|---|---|',
      '| Kokoro | 82M |',
      '',
      '> a quote',
      'Bare link https://example.com/x here, and `inline code`.',
    ].join('\n');
    const { text, truncated } = speechText(md);
    expect(truncated).toBe(false);
    expect(text).toBe(
      [
        'Local TTS.',
        '',
        'Read this and see the docs or Beta and gamma.',
        '',
        'first item.',
        'done item.',
        'numbered.',
        '',
        'Model, Size.',
        'Kokoro, 82M.',
        '',
        'a quote.',
        'Bare link here, and inline code.',
      ].join('\n'),
    );
    expect(text).not.toContain('rm -rf');
    expect(text).not.toContain('title:');
  });

  it('cuts very long notes at a sentence and says so', () => {
    const { text, truncated } = speechText('This is a sentence. '.repeat(3000));
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan(MAX_SPEECH_CHARS + 100);
    expect(text.endsWith('The rest of this note was cut off.')).toBe(true);
  });
});

let root: string;
let data: string;
let calls: { url: string; body: Record<string, unknown> }[];
let speechUp: boolean;

/** Stands in for mlx-audio: records requests, answers with fake MP3 bytes. */
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (!speechUp) throw new TypeError('fetch failed');
  if (u.endsWith('/v1/audio/speech')) {
    calls.push({ url: u, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(Buffer.from('ID3fake-mp3'), { status: 200, headers: { 'Content-Type': 'audio/mp3' } });
  }
  return new Response('ok', { status: 200 });
}) as typeof fetch;

function makeApp(deployment: 'local' | 'server' = 'local') {
  return createApp({
    modules: ALL_MODULES,
    vaultRoot: root,
    deployment,
    auth:
      deployment === 'server'
        ? { passwordHash: 'x', totpSecret: 'JBSWY3DPEHPK3PXP', publicOrigin: 'https://example.test' }
        : undefined,
    voice: {
      settingsFile: join(data, 'voice-settings.json'),
      cacheDir: join(data, 'tts'),
      ttsUrl: 'http://tts.test',
      ttsModel: 'kokoro-test',
      fetchFn: fakeFetch,
    },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'voice-vault-'));
  data = await mkdtemp(join(tmpdir(), 'voice-data-'));
  await mkdir(join(root, 'notes'), { recursive: true });
  await writeFile(join(root, 'notes/alpha.md'), '---\ntitle: Alpha\n---\n\n# Alpha\n\nHello there.\n');
  await writeFile(join(root, 'notes/empty.md'), '---\ntitle: Empty\n---\n');
  await writeFile(join(root, 'notes/pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await truncateAll();
  await scanVault({ root, sourceId: await vaultSourceId() });
  calls = [];
  speechUp = true;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
});

describe('/api/voice/settings', () => {
  it('defaults to auto-speak off with the af_heart voice, and reports the server', async () => {
    const res = await request(makeApp()).get('/api/voice/settings');
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ autoSpeak: false, voice: 'af_heart', minTaskSeconds: 120 });
    expect(res.body.server).toEqual({ url: 'http://tts.test', model: 'kokoro-test', up: true });
  });

  it('saves a toggle to the file the Claude Code hook reads', async () => {
    const res = await request(makeApp()).put('/api/voice/settings').send({ autoSpeak: true });
    expect(res.status).toBe(200);
    expect(res.body.settings.autoSpeak).toBe(true);
    const onDisk = JSON.parse(await readFile(join(data, 'voice-settings.json'), 'utf8'));
    expect(onDisk).toEqual({ autoSpeak: true, voice: 'af_heart', minTaskSeconds: 120 });
    expect((await readVoiceSettings(join(data, 'voice-settings.json'))).autoSpeak).toBe(true);
  });

  it('rejects unknown keys and bad values', async () => {
    const app = makeApp();
    expect((await request(app).put('/api/voice/settings').send({ autoSpeak: 'yes' })).status).toBe(400);
    expect((await request(app).put('/api/voice/settings').send({ volume: 3 })).status).toBe(400);
    expect((await request(app).put('/api/voice/settings').send({ voice: '../x' })).status).toBe(400);
  });

  it('reports the speech server as down when it does not answer', async () => {
    speechUp = false;
    const res = await request(makeApp()).get('/api/voice/settings');
    expect(res.body.server.up).toBe(false);
  });
});

describe('POST /api/voice/speak', () => {
  it('voices a note as speech text, then serves the second request from the cache', async () => {
    const app = makeApp();
    const first = await request(app).post('/api/voice/speak').send({ path: 'notes/alpha.md' });
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/^audio\/mpeg/);
    expect(first.headers['x-speech-cache']).toBe('miss');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({
      model: 'kokoro-test',
      input: 'Alpha.\n\nHello there.',
      voice: 'af_heart',
      response_format: 'mp3',
    });

    const second = await request(app).post('/api/voice/speak').send({ path: 'notes/alpha.md' });
    expect(second.status).toBe(200);
    expect(second.headers['x-speech-cache']).toBe('hit');
    expect(calls).toHaveLength(1);
  });

  it('fails closed when the local server is down: no cloud fallback', async () => {
    speechUp = false;
    const res = await request(makeApp()).post('/api/voice/speak').send({ path: 'notes/alpha.md' });
    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/com\.argo\.tts/);
  });

  it('refuses paths outside the vault, non-notes and empty notes', async () => {
    const app = makeApp();
    expect((await request(app).post('/api/voice/speak').send({ path: '../etc/passwd' })).status).toBe(400);
    expect((await request(app).post('/api/voice/speak').send({ path: 'notes/pic.png' })).status).toBe(415);
    expect((await request(app).post('/api/voice/speak').send({ path: 'notes/empty.md' })).status).toBe(422);
    expect(calls).toHaveLength(0);
  });
});

describe('on a server deployment', () => {
  it('does not mount the voice routes at all', async () => {
    const res = await request(makeApp('server')).get('/api/voice/settings');
    expect([401, 404]).toContain(res.status);
  });
});
